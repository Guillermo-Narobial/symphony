import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { config } from "./config.js";

const exec = promisify(execFile);

const REPO = config.repo;
const LABEL = "audit:weak-test";
const ASSIGNEE = config.rejectAssignee;
const WORK_DIR = resolve(config.frontendRepoDir);
const REPORT_PATH = resolve(WORK_DIR, "reports/mutation/mutation.json");
const SURVIVAL_THRESHOLD = 3; // mínimo mutantes sobrevivientes por archivo para abrir issue

interface MutantResult {
  id: string;
  mutatorName: string;
  status: string;
  fileName: string;
  location: { start: { line: number; column: number } };
  replacement?: string;
}

interface StrykerReport {
  files: Record<string, { mutants: MutantResult[] }>;
}

interface WeakTestGroup {
  file: string;
  survived: MutantResult[];
  total: number;
  score: number;
}

async function ensureLabel(): Promise<void> {
  try {
    await exec("gh", ["label", "create", LABEL, "-R", REPO, "--color", "FBCA04", "--description", "Test débil detectado por mutation testing"], { timeout: 10_000 });
  } catch { /* ya existe */ }
}

async function issueExists(title: string): Promise<boolean> {
  const { stdout } = await exec("gh", [
    "issue", "list", "-R", REPO,
    "--state", "open", "--search", `"${title}" in:title`,
    "--json", "number", "--limit", "3",
  ]);
  return JSON.parse(stdout).length > 0;
}

async function runStryker(): Promise<void> {
  console.log("🧬 Ejecutando Stryker mutation testing...");
  await exec("npx", ["stryker", "run"], {
    cwd: WORK_DIR,
    timeout: 30 * 60_000, // 30 min max
    maxBuffer: 50 * 1024 * 1024,
  });
}

async function parseReport(): Promise<WeakTestGroup[]> {
  const raw = await readFile(REPORT_PATH, "utf-8");
  const report: StrykerReport = JSON.parse(raw);
  const groups: WeakTestGroup[] = [];

  for (const [file, data] of Object.entries(report.files)) {
    const survived = data.mutants.filter((m) => m.status === "Survived");
    const total = data.mutants.length;
    if (survived.length >= SURVIVAL_THRESHOLD) {
      groups.push({ file, survived, total, score: Math.round(((total - survived.length) / total) * 100) });
    }
  }

  return groups.sort((a, b) => a.score - b.score); // peores primero
}

function buildIssueBody(group: WeakTestGroup): string {
  const examples = group.survived.slice(0, 5).map((m) =>
    `- L${m.location.start.line}: \`${m.mutatorName}\`${m.replacement ? ` → \`${m.replacement}\`` : ""}`
  ).join("\n");

  return `## 🧬 Mutation testing — tests débiles

**Archivo:** \`${group.file}\`
**Score:** ${group.score}% (${group.survived.length}/${group.total} mutantes sobrevivieron)

## Mutantes no detectados (ejemplos)

${examples}

## Instrucciones

- Revisa los tests de \`${group.file.replace(/\.ts$/, ".spec.ts")}\`
- Añade assertions que detecten las mutaciones listadas
- Ejecuta \`npx stryker run --mutate "${group.file}"\` para verificar mejora
- Objetivo: score ≥ 80%

---
_Generado por symphony-agent mutator (domingos)._`;
}

async function createIssues(groups: WeakTestGroup[]): Promise<void> {
  await ensureLabel();

  for (const group of groups) {
    const shortFile = group.file.replace(/^src\/app\//, "");
    const title = `[mutation] Tests débiles en ${shortFile} (${group.score}%)`;

    if (await issueExists(title)) {
      console.log(`⏭️  Ya existe: ${title}`);
      continue;
    }

    const { stdout } = await exec("gh", [
      "issue", "create", "-R", REPO,
      "--title", title,
      "--body", buildIssueBody(group),
      "--label", LABEL,
      "--assignee", ASSIGNEE,
    ]);
    console.log(`✅ Creada: ${stdout.trim()}`);
  }
}

async function main(): Promise<void> {
  console.log("🧬 Mutation testing periódico — inicio");

  // 1. Sync repo
  await exec("git", ["fetch", "origin"], { cwd: WORK_DIR });
  await exec("git", ["checkout", "hotfix-master"], { cwd: WORK_DIR });
  await exec("git", ["pull", "--ff-only"], { cwd: WORK_DIR });

  // 2. Ejecutar Stryker
  try {
    await runStryker();
  } catch (err: any) {
    // Stryker sale con código != 0 si hay mutantes sobrevivientes, pero genera el report
    if (!err.stdout?.includes("Mutation testing complete")) {
      throw err;
    }
  }

  // 3. Parsear resultados
  const groups = await parseReport();
  console.log(`📋 ${groups.length} archivos con tests débiles (≥${SURVIVAL_THRESHOLD} mutantes sobrevivientes)`);

  if (groups.length === 0) {
    console.log("🎉 Todos los tests son robustos");
    return;
  }

  // 4. Abrir issues
  await createIssues(groups);
  console.log("🏁 Mutation testing completado");
}

main().catch((err) => {
  console.error("❌ Error en mutator:", err);
  process.exit(1);
});
