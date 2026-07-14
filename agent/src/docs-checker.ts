import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { config } from "./config.js";
import { notifyRejectionEmail } from "./notifier-email.js";

const exec = promisify(execFile);

const SOURCE_REPO_DIR = resolve(config.frontendRepoDir);
const BRANCH = "hotfix-master";
const LABEL = "docs:jsdoc";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 20,
    timeout: 300_000,
    env: process.env,
  });
  return stdout.trim();
}

async function prepareRepo(): Promise<{ workDir: string; cleanup: () => Promise<void> }> {
  const tempRoot = await mkdtemp(join(tmpdir(), "symphony-docs-"));
  const workDir = join(tempRoot, "Narobial-Frontend");
  const originUrl = await git(SOURCE_REPO_DIR, "config", "--get", "remote.origin.url");

  await exec("git", ["clone", "--no-local", "--branch", BRANCH, "--single-branch", SOURCE_REPO_DIR, workDir], {
    maxBuffer: 1024 * 1024 * 20,
    timeout: 300_000,
    env: process.env,
  });
  await git(workDir, "remote", "set-url", "origin", originUrl);
  await git(workDir, "fetch", "origin", BRANCH, "--prune");
  await git(workDir, "checkout", BRANCH);
  await git(workDir, "reset", "--hard", `origin/${BRANCH}`);

  return {
    workDir,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

async function getRecentFiles(workDir: string): Promise<string[]> {
  const { stdout } = await exec("git", [
    "log", "--since=7.days", "--diff-filter=AM", "--name-only", "--pretty=format:",
  ], { cwd: workDir });

  const files = [...new Set(stdout.split("\n").filter((f) => f.endsWith(".ts") && f.startsWith("src/app/") && !f.includes(".spec.")))];
  return files;
}

function hasJSDocAbove(lines: string[], index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (trimmed.endsWith("*/")) return true;
    if (trimmed.startsWith("@") || trimmed.startsWith("//")) return false;
    return false;
  }
  return false;
}

interface UndocumentedItem {
  file: string;
  line: number;
  code: string;
}

async function findUndocumented(workDir: string, files: string[]): Promise<UndocumentedItem[]> {
  const items: UndocumentedItem[] = [];
  const patterns = [
    /export\s+(function|class|interface|type|enum)\s+\w+/,
    /^\s+(public|protected)\s+\w+\s*\(/,
    /^\s+\w+\s*\([^)]*\)\s*[:{]/,
  ];

  for (const file of files) {
    try {
      const content = await readFile(resolve(workDir, file), "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (patterns.some((p) => p.test(line)) && !hasJSDocAbove(lines, i)) {
          items.push({ file, line: i + 1, code: line.trim() });
        }
      }
    } catch {}
  }

  return items;
}

async function generateDocs(workDir: string, items: UndocumentedItem[]): Promise<string[]> {
  const byFile = new Map<string, UndocumentedItem[]>();
  for (const item of items) {
    const list = byFile.get(item.file) || [];
    list.push(item);
    byFile.set(item.file, list);
  }

  const modifiedFiles: string[] = [];

  for (const [file, fileItems] of byFile) {
    const filePath = resolve(workDir, file);
    const lines = fileItems.map((i) => `L${i.line}: ${i.code}`).join("\n");

    const prompt = `Lee el archivo "${file}" y añade JSDoc (/** ... */) a estas funciones/interfaces/métodos que no lo tienen:\n${lines}\n\nReglas:\n- Solo añade el bloque /** */ encima de cada declaración\n- Incluye @param, @returns donde aplique\n- Para interfaces, documenta el propósito y cada propiedad\n- No modifiques el código, solo añade documentación\n- Responde SOLO con el archivo completo modificado, sin explicaciones`;

    try {
      const output = await runKiro(prompt, workDir);
      if (output.trim()) {
        await writeFile(filePath, output);
        modifiedFiles.push(file);
      }
    } catch (err) {
      console.error(`  ⚠️ Error documentando ${file}:`, err);
    }
  }

  return modifiedFiles;
}

async function runKiro(prompt: string, workDir: string): Promise<string> {
  return new Promise((ok, fail) => {
    let stdout = "";
    const proc = spawn("kiro-cli", ["chat", "--no-interactive", "--trust-all-tools", "--wrap", "never", prompt], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => process.stderr.write(d));
    proc.on("close", (code) => {
      if (code === 0) ok(stdout);
      else fail(new Error(`kiro-cli exited ${code}`));
    });
    proc.on("error", fail);
  });
}

async function createPR(workDir: string, modifiedFiles: string[], items: UndocumentedItem[]): Promise<string | null> {
  const date = new Date().toISOString().slice(0, 10);
  const prBranch = `docs/jsdoc-${date}`;

  const { stdout: diff } = await exec("git", ["diff", "--stat"], { cwd: workDir });
  if (!diff.trim()) return null;

  await git(workDir, "checkout", "-b", prBranch);
  await git(workDir, "add", ...modifiedFiles);
  await git(workDir, "commit", "-m", `docs: añadir JSDoc a ${modifiedFiles.length} archivos`);
  await git(workDir, "push", "-u", "origin", prBranch);

  const body = buildPRBody(items, modifiedFiles);

  try {
    await exec("gh", ["label", "create", LABEL, "-R", config.repo, "--color", "0075CA"], { timeout: 10_000 });
  } catch {}

  const { stdout: prUrl } = await exec("gh", [
    "pr", "create", "-R", config.repo,
    "--base", BRANCH,
    "--head", prBranch,
    "--title", `docs: JSDoc automático ${date}`,
    "--body", body,
    "--label", LABEL,
    "--assignee", config.rejectAssignee,
  ]);

  await git(workDir, "checkout", BRANCH);

  return prUrl.trim();
}

function buildPRBody(items: UndocumentedItem[], modifiedFiles: string[]): string {
  const fileList = modifiedFiles.map((f) => `- \`${f}\``).join("\n");
  const examples = items.slice(0, 10).map((i) => `| \`${i.file}\` | L${i.line} | \`${i.code.slice(0, 60)}\` |`).join("\n");

  return `## 📝 Documentación JSDoc automática

### Archivos documentados (${modifiedFiles.length})

${fileList}

### Elementos documentados (${items.length} total)

| Archivo | Línea | Declaración |
|---------|-------|-------------|
${examples}

### Verificación requerida

- [ ] JSDoc es correcto y coherente
- [ ] No se ha modificado lógica de negocio
- [ ] Build pasa sin errores

---
_Generado por symphony-agent docs-checker._`;
}

async function main(): Promise<void> {
  console.log("📝 Agente de documentación — inicio");
  const repo = await prepareRepo();

  try {
    const files = await getRecentFiles(repo.workDir);
    console.log(`📂 ${files.length} archivos .ts modificados en los últimos 7 días`);

    if (files.length === 0) {
      console.log("✅ Sin archivos nuevos que documentar");
      return;
    }

    const items = await findUndocumented(repo.workDir, files);
    console.log(`🔍 ${items.length} funciones/interfaces/métodos sin JSDoc`);

    if (items.length === 0) {
      console.log("✅ Todo documentado correctamente");
      return;
    }

    const modifiedFiles = await generateDocs(repo.workDir, items);
    console.log(`✏️ ${modifiedFiles.length} archivos documentados`);

    if (modifiedFiles.length === 0) {
      console.log("⚠️ No se pudo generar documentación");
      return;
    }

    const prUrl = await createPR(repo.workDir, modifiedFiles, items);
    if (prUrl) {
      console.log(`🔗 PR creada: ${prUrl}`);
      await notifyRejectionEmail("DOCS", `Se ha creado una PR de documentación JSDoc:\n\n${prUrl}\n\n${modifiedFiles.length} archivos, ${items.length} elementos documentados.`);
    }

    console.log("🏁 Agente de documentación completado");
  } finally {
    await repo.cleanup();
  }
}

main().catch((err) => {
  console.error("❌ Error en docs-checker:", err);
  process.exit(1);
});
