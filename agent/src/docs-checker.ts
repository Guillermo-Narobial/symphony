import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { notifyEmail } from "./notifier-email.js";

const exec = promisify(execFile);

const SOURCE_REPO_DIR = resolve(config.frontendRepoDir);
const BRANCH = "hotfix-master";
const LABEL = "docs:jsdoc";
const MAX_FILES = positiveInteger(process.env.DOCS_MAX_FILES, 3);
const FILE_TIMEOUT_MS = positiveInteger(process.env.DOCS_FILE_TIMEOUT_MS, 240_000);
const DRY_RUN = process.env.DOCS_DRY_RUN === "1";

interface RepoHandle {
  workDir: string;
  enablePush: () => Promise<void>;
  cleanup: () => Promise<void>;
}

interface UndocumentedItem {
  file: string;
  line: number;
  code: string;
}

function positiveInteger(rawValue: string | undefined, fallback: number): number {
  const value = Number(rawValue ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 20,
    timeout: 300_000,
    env: process.env,
  });
  return stdout.trim();
}

async function prepareRepo(): Promise<RepoHandle> {
  const tempRoot = await mkdtemp(join(tmpdir(), "symphony-docs-"));
  const workDir = join(tempRoot, "Narobial-Frontend");
  const originUrl = await git(SOURCE_REPO_DIR, "config", "--get", "remote.origin.url");

  try {
    await exec("git", ["clone", "--no-local", "--branch", BRANCH, "--single-branch", SOURCE_REPO_DIR, workDir], {
      maxBuffer: 1024 * 1024 * 20,
      timeout: 300_000,
      env: process.env,
    });
    await git(workDir, "remote", "set-url", "origin", originUrl);
    await git(workDir, "fetch", "origin", BRANCH, "--prune");
    await git(workDir, "reset", "--hard", `origin/${BRANCH}`);

    // Codex can edit the clone, but cannot publish anything while generating docs.
    await git(workDir, "remote", "set-url", "--push", "origin", "disabled://symphony-docs");

    return {
      workDir,
      enablePush: async () => {
        await git(workDir, "remote", "set-url", "--push", "origin", originUrl);
      },
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function getRecentFiles(workDir: string): Promise<string[]> {
  const { stdout } = await exec("git", [
    "log", "--since=7.days", "--diff-filter=AM", "--name-only", "--pretty=format:",
  ], { cwd: workDir, timeout: 60_000 });

  return [...new Set(stdout.split("\n").filter((file) =>
    file.endsWith(".ts") && file.startsWith("src/app/") && !file.includes(".spec."),
  ))];
}

function hasJSDocAbove(lines: string[], index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    return trimmed.endsWith("*/");
  }
  return false;
}

async function findUndocumented(workDir: string, files: string[]): Promise<UndocumentedItem[]> {
  const items: UndocumentedItem[] = [];
  const patterns = [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const)\s+\w+/,
    /^\s+(?:public|protected)\s+(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\(/,
  ];

  for (const file of files) {
    try {
      const content = await readFile(resolve(workDir, file), "utf8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (patterns.some((pattern) => pattern.test(line)) && !hasJSDocAbove(lines, i)) {
          items.push({ file, line: i + 1, code: line.trim() });
        }
      }
    } catch (error) {
      console.warn(`⚠️ No se pudo analizar ${file}: ${(error as Error).message}`);
    }
  }

  return items;
}

function withoutJSDoc(source: string): string {
  return source
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n");
}

function jsDocCount(source: string): number {
  return source.match(/\/\*\*[\s\S]*?\*\//g)?.length ?? 0;
}

function isDocumentationOnlyChange(before: string, after: string): boolean {
  return withoutJSDoc(before) === withoutJSDoc(after) && jsDocCount(after) > jsDocCount(before);
}

async function restoreUnstagedChanges(workDir: string): Promise<void> {
  const changed = (await git(workDir, "diff", "--name-only")).split("\n").filter(Boolean);
  if (changed.length > 0) await git(workDir, "restore", "--worktree", "--", ...changed);

  const untracked = (await git(workDir, "ls-files", "--others", "--exclude-standard")).split("\n").filter(Boolean);
  for (const file of untracked) {
    await rm(resolve(workDir, file), { recursive: true, force: true });
  }
}

async function runCodexForFile(workDir: string, file: string, items: UndocumentedItem[]): Promise<boolean> {
  const filePath = resolve(workDir, file);
  const before = await readFile(filePath, "utf8");
  const declarations = items.map((item) => `L${item.line}: ${item.code}`).join("\n");
  const prompt = `Edita exclusivamente el archivo ${file} y añade JSDoc a estas declaraciones:\n${declarations}\n\nReglas obligatorias:\n- Solo puedes añadir bloques /** ... */ encima de las declaraciones indicadas.\n- Incluye @param y @returns únicamente cuando correspondan.\n- No cambies código, imports, formato ni tests.\n- No ejecutes git, no hagas commit, push ni crees archivos.\n- Termina tras guardar el archivo.`;

  try {
    await exec("codex", [
      "exec",
      "--ephemeral",
      "--color", "never",
      "--sandbox", "workspace-write",
      "-C", workDir,
      prompt,
    ], {
      cwd: workDir,
      timeout: FILE_TIMEOUT_MS,
      killSignal: "SIGTERM",
      maxBuffer: 1024 * 1024 * 20,
      env: process.env,
    });

    const changed = (await git(workDir, "diff", "--name-only")).split("\n").filter(Boolean);
    if (changed.some((changedFile) => changedFile !== file)) {
      throw new Error(`Codex modificó archivos fuera de alcance: ${changed.filter((changedFile) => changedFile !== file).join(", ")}`);
    }

    const after = await readFile(filePath, "utf8");
    if (!isDocumentationOnlyChange(before, after)) {
      throw new Error("el diff contiene cambios fuera de bloques JSDoc o no añadió documentación");
    }

    await git(workDir, "add", "--", file);
    console.log(`✅ JSDoc validado: ${file}`);
    return true;
  } catch (error) {
    console.error(`⚠️ Se descarta ${file}: ${(error as Error).message}`);
    await restoreUnstagedChanges(workDir);
    return false;
  }
}

async function generateDocs(workDir: string, items: UndocumentedItem[]): Promise<{ modifiedFiles: string[]; selectedItems: UndocumentedItem[] }> {
  const byFile = new Map<string, UndocumentedItem[]>();
  for (const item of items) {
    const list = byFile.get(item.file) ?? [];
    list.push(item);
    byFile.set(item.file, list);
  }

  const selected = [...byFile.entries()].slice(0, MAX_FILES);
  const selectedItems = selected.flatMap(([, fileItems]) => fileItems);
  console.log(`🎯 Se procesarán ${selected.length}/${byFile.size} archivos (máximo ${MAX_FILES})`);

  if (DRY_RUN) return { modifiedFiles: [], selectedItems };

  const modifiedFiles: string[] = [];
  for (const [file, fileItems] of selected) {
    if (await runCodexForFile(workDir, file, fileItems)) modifiedFiles.push(file);
  }

  return { modifiedFiles, selectedItems };
}

function buildPRBody(items: UndocumentedItem[], modifiedFiles: string[]): string {
  const modifiedSet = new Set(modifiedFiles);
  const documentedItems = items.filter((item) => modifiedSet.has(item.file));
  const fileList = modifiedFiles.map((file) => `- \`${file}\``).join("\n");
  const examples = documentedItems.slice(0, 10).map((item) =>
    `| \`${item.file}\` | L${item.line} | \`${item.code.slice(0, 60)}\` |`,
  ).join("\n");

  return `## Documentación JSDoc automática con Codex

### Archivos documentados (${modifiedFiles.length})

${fileList}

### Declaraciones documentadas (${documentedItems.length})

| Archivo | Línea original | Declaración |
|---------|----------------|-------------|
${examples}

### Controles aplicados

- [x] Timeout independiente por archivo
- [x] Solo se aceptan cambios dentro de bloques JSDoc
- [x] Push deshabilitado durante la ejecución de Codex
- [ ] Revisión humana de exactitud semántica

---
_Generado por symphony-agent docs-checker._`;
}

async function createPR(repo: RepoHandle, modifiedFiles: string[], items: UndocumentedItem[]): Promise<string | null> {
  const { workDir } = repo;
  const { stdout: diff } = await exec("git", ["diff", "--cached", "--stat"], { cwd: workDir });
  if (!diff.trim()) return null;

  const date = new Date().toISOString().slice(0, 10);
  const prBranch = `docs/jsdoc-${date}`;
  await git(workDir, "checkout", "-b", prBranch);
  await git(workDir, "commit", "-m", `docs: añadir JSDoc a ${modifiedFiles.length} archivos`);
  await repo.enablePush();
  await git(workDir, "push", "-u", "origin", prBranch);

  try {
    await exec("gh", ["label", "create", LABEL, "-R", config.repo, "--color", "0075CA"], { timeout: 10_000 });
  } catch {
    // The label usually already exists.
  }

  const { stdout: prUrl } = await exec("gh", [
    "pr", "create", "-R", config.repo,
    "--base", BRANCH,
    "--head", prBranch,
    "--title", `docs: JSDoc automático con Codex ${date}`,
    "--body", buildPRBody(items, modifiedFiles),
    "--label", LABEL,
    "--assignee", config.rejectAssignee,
  ], { timeout: 60_000 });

  return prUrl.trim();
}

async function main(): Promise<void> {
  console.log(`📝 Agente de documentación Codex — inicio${DRY_RUN ? " (dry-run)" : ""}`);
  const repo = await prepareRepo();

  try {
    const files = await getRecentFiles(repo.workDir);
    console.log(`📂 ${files.length} archivos TypeScript modificados en los últimos 7 días`);
    if (files.length === 0) return;

    const items = await findUndocumented(repo.workDir, files);
    console.log(`🔍 ${items.length} declaraciones públicas/exportadas sin JSDoc`);
    if (items.length === 0) return;

    const { modifiedFiles, selectedItems } = await generateDocs(repo.workDir, items);
    if (DRY_RUN) {
      console.log(`✅ Dry-run correcto: ${selectedItems.length} declaraciones candidatas`);
      return;
    }
    if (modifiedFiles.length === 0) {
      console.log("⚠️ Codex no produjo cambios JSDoc válidos");
      return;
    }

    const prUrl = await createPR(repo, modifiedFiles, selectedItems);
    if (prUrl) {
      console.log(`🔗 PR creada: ${prUrl}`);
      await notifyEmail(
        `📝 [Symphony] PR de documentación Codex — ${new Date().toISOString().slice(0, 10)}`,
        `<h2>PR de documentación JSDoc</h2><p><a href="${prUrl}">${prUrl}</a></p><p>${modifiedFiles.length} archivos validados como cambios exclusivos de JSDoc.</p>`,
      );
    }
  } finally {
    await repo.cleanup();
  }

  console.log("🏁 Agente de documentación completado");
}

main().catch((error) => {
  console.error("❌ Error en docs-checker:", error);
  process.exit(1);
});
