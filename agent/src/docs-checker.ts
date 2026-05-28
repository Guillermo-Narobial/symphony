import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { notifyRejectionEmail } from "./notifier-email.js";

const exec = promisify(execFile);

const WORK_DIR = resolve(config.frontendRepoDir);
const BRANCH = "hotfix-master";
const LABEL = "docs:jsdoc";

const UNDOCUMENTED_RE = /^(?!\s*\/\*\*).*(?:export\s+(?:function|class|interface|type|enum)\s+\w|(?:public|protected)\s+\w+\s*\(|^\s+\w+\s*\([^)]*\)\s*[:{])/;

async function syncRepo(): Promise<void> {
  await exec("git", ["fetch", "origin"], { cwd: WORK_DIR });
  await exec("git", ["checkout", BRANCH], { cwd: WORK_DIR });
  await exec("git", ["pull", "origin", BRANCH, "--ff-only"], { cwd: WORK_DIR });
}

async function getRecentFiles(): Promise<string[]> {
  const { stdout } = await exec("git", [
    "log", "--since=7.days", "--diff-filter=AM", "--name-only", "--pretty=format:",
  ], { cwd: WORK_DIR });

  const files = [...new Set(stdout.split("\n").filter((f) => f.endsWith(".ts") && f.startsWith("src/app/") && !f.includes(".spec.")))];
  return files;
}

function hasJSDocAbove(lines: string[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
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

async function findUndocumented(files: string[]): Promise<UndocumentedItem[]> {
  const items: UndocumentedItem[] = [];
  const patterns = [
    /export\s+(function|class|interface|type|enum)\s+\w+/,
    /^\s+(public|protected)\s+\w+\s*\(/,
    /^\s+\w+\s*\([^)]*\)\s*[:{]/,
  ];

  for (const file of files) {
    try {
      const content = await readFile(resolve(WORK_DIR, file), "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (patterns.some((p) => p.test(line)) && !hasJSDocAbove(lines, i)) {
          items.push({ file, line: i + 1, code: line.trim() });
        }
      }
    } catch { /* archivo eliminado entre log y lectura */ }
  }

  return items;
}

async function generateDocs(items: UndocumentedItem[]): Promise<string[]> {
  // Agrupar por archivo
  const byFile = new Map<string, UndocumentedItem[]>();
  for (const item of items) {
    const list = byFile.get(item.file) || [];
    list.push(item);
    byFile.set(item.file, list);
  }

  const modifiedFiles: string[] = [];

  for (const [file, fileItems] of byFile) {
    const filePath = resolve(WORK_DIR, file);
    const lines = fileItems.map((i) => `L${i.line}: ${i.code}`).join("\n");

    const prompt = `Lee el archivo "${file}" y añade JSDoc (/** ... */) a estas funciones/interfaces/métodos que no lo tienen:\n${lines}\n\nReglas:\n- Solo añade el bloque /** */ encima de cada declaración\n- Incluye @param, @returns donde aplique\n- Para interfaces, documenta el propósito y cada propiedad\n- No modifiques el código, solo añade documentación\n- Responde SOLO con el archivo completo modificado, sin explicaciones`;

    try {
      const output = await runKiro(prompt, filePath);
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

async function runKiro(prompt: string, filePath: string): Promise<string> {
  return new Promise((ok, fail) => {
    let stdout = "";
    const proc = spawn("kiro-cli", ["chat", "--no-interactive", "--trust-all-tools", "--wrap", "never", prompt], {
      cwd: WORK_DIR,
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

async function createPR(modifiedFiles: string[], items: UndocumentedItem[]): Promise<string | null> {
  const date = new Date().toISOString().slice(0, 10);
  const prBranch = `docs/jsdoc-${date}`;

  // Verificar si hay cambios reales
  const { stdout: diff } = await exec("git", ["diff", "--stat"], { cwd: WORK_DIR });
  if (!diff.trim()) return null;

  await exec("git", ["checkout", "-b", prBranch], { cwd: WORK_DIR });
  await exec("git", ["add", ...modifiedFiles], { cwd: WORK_DIR });
  await exec("git", ["commit", "-m", `docs: añadir JSDoc a ${modifiedFiles.length} archivos`], { cwd: WORK_DIR });
  await exec("git", ["push", "-u", "origin", prBranch], { cwd: WORK_DIR });

  const body = buildPRBody(items, modifiedFiles);

  try {
    await exec("gh", ["label", "create", LABEL, "-R", config.repo, "--color", "0075CA"], { timeout: 10_000 });
  } catch { /* ya existe */ }

  const { stdout: prUrl } = await exec("gh", [
    "pr", "create", "-R", config.repo,
    "--base", BRANCH,
    "--head", prBranch,
    "--title", `docs: JSDoc automático ${date}`,
    "--body", body,
    "--label", LABEL,
    "--assignee", config.rejectAssignee,
  ]);

  // Volver a branch principal
  await exec("git", ["checkout", BRANCH], { cwd: WORK_DIR });

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

  await syncRepo();

  const files = await getRecentFiles();
  console.log(`📂 ${files.length} archivos .ts modificados en los últimos 7 días`);

  if (files.length === 0) {
    console.log("✅ Sin archivos nuevos que documentar");
    return;
  }

  const items = await findUndocumented(files);
  console.log(`🔍 ${items.length} funciones/interfaces/métodos sin JSDoc`);

  if (items.length === 0) {
    console.log("✅ Todo documentado correctamente");
    return;
  }

  const modifiedFiles = await generateDocs(items);
  console.log(`✏️ ${modifiedFiles.length} archivos documentados`);

  if (modifiedFiles.length === 0) {
    console.log("⚠️ No se pudo generar documentación");
    return;
  }

  const prUrl = await createPR(modifiedFiles, items);
  if (prUrl) {
    console.log(`🔗 PR creada: ${prUrl}`);
    await notifyRejectionEmail("DOCS", `Se ha creado una PR de documentación JSDoc:\n\n${prUrl}\n\n${modifiedFiles.length} archivos, ${items.length} elementos documentados.`);
  }

  console.log("🏁 Agente de documentación completado");
}

main().catch((err) => {
  console.error("❌ Error en docs-checker:", err);
  process.exit(1);
});
