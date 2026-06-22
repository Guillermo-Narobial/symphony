import "dotenv/config";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { notifyEmail } from "./notifier-email.js";

const exec = promisify(execFile);
const WORK_DIR = resolve(config.frontendRepoDir);
const COVERAGE_THRESHOLD = Number(process.env.COVERAGE_THRESHOLD ?? "85");
const LABEL = "audit:low-coverage";
const FAILURE_LABEL = "audit:coverage-pipeline";
const REPORT_PATH = resolve(WORK_DIR, "reports/coverage/low-coverage.json");
const SUMMARY_PATH = resolve(WORK_DIR, "coverage/coverage-summary.json");
const STATE_PATH = resolve("/home/gcalleja/code/symphony-logs", "coverage-audit-state.json");
const HEARTBEAT_MS = 30_000;
const MAX_DIAGNOSTICS = 40;

interface CoverageMetric {
  total?: number;
  covered?: number;
  skipped?: number;
  pct?: number;
}

interface CoverageEntry {
  lines?: CoverageMetric;
  branches?: CoverageMetric;
  functions?: CoverageMetric;
  statements?: CoverageMetric;
}

interface LowCoverageFile {
  file: string;
  spec: string;
  lines: number;
  branches: number;
  functions: number;
  statements: number;
  failingMetrics: string[];
}

interface AuditState {
  status: "starting" | "running" | "completed" | "failed";
  phase: string;
  startedAt: string;
  updatedAt: string;
  threshold: number;
  reportPath: string;
  summaryPath: string;
  resultCount?: number;
  error?: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorMessage?: string;
}

const runtimeState: AuditState = {
  status: "starting",
  phase: "boot",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  threshold: COVERAGE_THRESHOLD,
  reportPath: REPORT_PATH,
  summaryPath: SUMMARY_PATH,
};

async function saveState(patch?: Partial<AuditState>): Promise<void> {
  Object.assign(runtimeState, patch ?? {});
  runtimeState.updatedAt = new Date().toISOString();
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(runtimeState, null, 2));
}

function setPhase(phase: string): void {
  runtimeState.phase = phase;
}

function startHeartbeat(): NodeJS.Timeout {
  return setInterval(() => {
    void saveState({ status: runtimeState.status, phase: runtimeState.phase, resultCount: runtimeState.resultCount, error: runtimeState.error });
    console.log(`⏱️  heartbeat ${new Date().toISOString()} phase=${runtimeState.phase}`);
  }, HEARTBEAT_MS);
}

function normalizePath(file: string): string {
  return file.replace(`${WORK_DIR}/`, "").replace(/\\/g, "/");
}

function toPct(metric: CoverageMetric | undefined): number {
  return metric?.pct ?? 100;
}

function expectedSpecFor(file: string): string {
  return file.replace(/\.ts$/, ".spec.ts");
}

function buildIssueTitle(entry: LowCoverageFile): string {
  const shortFile = entry.file.replace(/^src\/app\//, "");
  return `[coverage] Cobertura baja en ${shortFile} (L${entry.lines}% B${entry.branches}%)`;
}

function buildPipelineIssueTitle(): string {
  return `[coverage] Pipeline de cobertura roto (${new Date().toISOString().slice(0, 10)})`;
}

function extractDiagnostics(output: string): string[] {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const interesting = lines.filter((line) =>
    line.includes(" FAIL ")
    || line.includes("❯")
    || line.startsWith("Error:")
    || line.startsWith("Failed to parse")
    || line.includes("Unhandled Error")
    || line.includes("0 test")
    || line.includes("failed")
  );
  return [...new Set(interesting)].slice(0, MAX_DIAGNOSTICS);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureLabel(label: string, color: string, description: string): Promise<void> {
  try {
    await exec("gh", ["label", "create", label, "-R", config.repo, "--color", color, "--description", description], { timeout: 10_000 });
  } catch {}
}

async function issueExists(title: string): Promise<boolean> {
  const { stdout } = await exec("gh", ["issue", "list", "-R", config.repo, "--state", "open", "--search", `"${title}" in:title`, "--json", "number", "--limit", "3"]);
  return JSON.parse(stdout).length > 0;
}

async function createIssues(entries: LowCoverageFile[]): Promise<void> {
  setPhase("creating-issues");
  await saveState({ status: "running", resultCount: entries.length });
  await ensureLabel(LABEL, "BFD4F2", "Cobertura de tests por debajo del umbral");
  for (const entry of entries) {
    const title = buildIssueTitle(entry);
    if (await issueExists(title)) {
      console.log(`⏭️  Ya existe: ${title}`);
      continue;
    }

    const body = `## 📉 Cobertura de tests por debajo de ${COVERAGE_THRESHOLD}%

**Archivo productivo:** \`${entry.file}\`
**Spec esperado:** \`${entry.spec}\`

### Métricas

- Líneas: **${entry.lines}%**
- Branches: **${entry.branches}%**
- Functions: **${entry.functions}%**
- Statements: **${entry.statements}%**

### Métricas por debajo del umbral

${entry.failingMetrics.map((metric) => `- ${metric}`).join("\n")}

### Qué hacer para solucionarlo

1. Refuerza el spec existente o crea el spec faltante para \`${entry.file}\`.
2. Cubre explícitamente ramas condicionales, retornos tempranos, casos de error, estado vacío y efectos laterales.
3. Añade assertions de comportamiento observable; evita tests que inspeccionen implementación interna si no es contrato público.
4. Ejecuta coverage local hasta dejar al menos líneas y branches por encima de ${COVERAGE_THRESHOLD}%.
5. Si el archivo no es testeable con el patrón actual, documenta el bloqueo técnico y propone el refactor mínimo necesario.

### Criterio de aceptación

- \`${entry.file}\` supera ${COVERAGE_THRESHOLD}% en líneas y branches.
- El spec asociado pasa en local.
- No se introducen regresiones en otros tests.

---
_Generado por symphony-agent coverage auditor._`;

    const { stdout } = await exec("gh", ["issue", "create", "-R", config.repo, "--title", title, "--body", body, "--label", LABEL, "--assignee", config.rejectAssignee]);
    console.log(`✅ Creada: ${stdout.trim()}`);
  }
}

async function createPipelineFailureIssue(result: CommandResult): Promise<void> {
  setPhase("reporting-pipeline-failure");
  await saveState({ status: "running", error: result.errorMessage ?? "coverage pipeline failed" });
  const title = buildPipelineIssueTitle();
  if (await issueExists(title)) {
    console.log(`⏭️  Ya existe: ${title}`);
    return;
  }

  await ensureLabel(FAILURE_LABEL, "D93F0B", "Pipeline de cobertura roto o incompleto");
  const diagnostics = extractDiagnostics(`${result.stdout}\n${result.stderr}`);
  const diagnosticsBlock = diagnostics.length > 0
    ? diagnostics.map((line) => `- ${line}`).join("\n")
    : "- No se pudieron extraer líneas diagnósticas útiles.";

  const body = `## 🚨 Pipeline de cobertura roto

El comando \`npm run test:unit:coverage\` no completó correctamente, por lo que no se puede generar el ranking fiable de archivos por debajo de ${COVERAGE_THRESHOLD}%.

### Qué ha fallado

- Comando: \`npm run test:unit:coverage\`
- Repo: \`${WORK_DIR}\`
- Summary esperado: \`${SUMMARY_PATH}\`
- Reporte esperado: \`${REPORT_PATH}\`

### Diagnóstico inicial

${diagnosticsBlock}

### Qué hacer para solucionarlo

1. Ejecuta \`npm run test:unit:coverage\` en local y reproduce el primer fallo real, no solo los errores derivados.
2. Corrige primero los tests que fallan sistemáticamente durante coverage.
3. Corrige o excluye de remapeo los archivos TypeScript que Vitest/Rollup no puede parsear durante coverage.
4. Si hay errores de \`jsdom\` por navegación, mockea o neutraliza esos flujos en los specs afectados.
5. Cuando \`coverage-summary.json\` se genere de forma estable, relanza el auditor para abrir issues de cobertura por archivo.

### Criterio de aceptación

- \`npm run test:unit:coverage\` termina con exit code 0.
- Se genera \`coverage/coverage-summary.json\`.
- El auditor puede construir el reporte de archivos por debajo de ${COVERAGE_THRESHOLD}%.

---
_Generado por symphony-agent coverage auditor._`;

  const { stdout } = await exec("gh", ["issue", "create", "-R", config.repo, "--title", title, "--body", body, "--label", FAILURE_LABEL, "--assignee", config.rejectAssignee]);
  console.log(`✅ Creada: ${stdout.trim()}`);
}

async function runCoverageCommand(): Promise<CommandResult> {
  setPhase("running-coverage");
  await saveState({ status: "running" });
  console.log(`📊 Ejecutando coverage con umbral ${COVERAGE_THRESHOLD}%...`);
  try {
    const { stdout, stderr } = await exec("npm", ["run", "test:unit:coverage"], { cwd: WORK_DIR, timeout: 900_000, maxBuffer: 150 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const commandError = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: commandError.stdout ?? "",
      stderr: commandError.stderr ?? "",
      errorMessage: commandError.message ?? String(error),
    };
  }
}

async function collectLowCoverage(): Promise<{ entries: LowCoverageFile[]; command: CommandResult }> {
  const command = await runCoverageCommand();

  const summaryExists = await pathExists(SUMMARY_PATH);
  if (!summaryExists) {
    throw new Error(command.errorMessage ?? `Coverage summary no generado en ${SUMMARY_PATH}`);
  }

  setPhase("parsing-summary");
  await saveState({ status: "running" });
  console.log(`📄 Leyendo ${SUMMARY_PATH}`);
  const raw = await readFile(SUMMARY_PATH, "utf-8");
  const summary = JSON.parse(raw) as Record<string, CoverageEntry>;
  const entries: LowCoverageFile[] = [];

  for (const [file, metrics] of Object.entries(summary)) {
    if (file === "total") continue;
    const normalized = normalizePath(file);
    if (!normalized.startsWith("src/app/") || !normalized.endsWith(".ts") || normalized.endsWith(".spec.ts")) continue;

    const lines = toPct(metrics.lines);
    const branches = toPct(metrics.branches);
    const functions = toPct(metrics.functions);
    const statements = toPct(metrics.statements);
    const failingMetrics = [
      lines < COVERAGE_THRESHOLD ? `lines: ${lines}%` : null,
      branches < COVERAGE_THRESHOLD ? `branches: ${branches}%` : null,
      functions < COVERAGE_THRESHOLD ? `functions: ${functions}%` : null,
      statements < COVERAGE_THRESHOLD ? `statements: ${statements}%` : null,
    ].filter((value): value is string => Boolean(value));

    if (failingMetrics.length === 0) continue;

    entries.push({
      file: normalized,
      spec: expectedSpecFor(normalized),
      lines,
      branches,
      functions,
      statements,
      failingMetrics,
    });
  }

  return {
    entries: entries.sort((a, b) => {
      const aMin = Math.min(a.lines, a.branches, a.functions, a.statements);
      const bMin = Math.min(b.lines, b.branches, b.functions, b.statements);
      return aMin - bMin || a.file.localeCompare(b.file);
    }),
    command,
  };
}

async function main(): Promise<void> {
  await saveState();
  const heartbeat = startHeartbeat();
  try {
    const { entries, command } = await collectLowCoverage();

    setPhase("writing-report");
    await saveState({ status: "running", resultCount: entries.length, error: command.ok ? undefined : command.errorMessage });
    await mkdir(dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, JSON.stringify({
      date: new Date().toISOString(),
      threshold: COVERAGE_THRESHOLD,
      total: entries.length,
      coverageCommandOk: command.ok,
      coverageCommandError: command.errorMessage,
      results: entries,
      diagnostics: extractDiagnostics(`${command.stdout}\n${command.stderr}`),
    }, null, 2));
    console.log(`💾 Reporte guardado en ${REPORT_PATH}`);

    if (!command.ok) {
      console.log("⚠️  Coverage terminó con errores; se usará el summary parcial si es válido y se abrirá issue del pipeline.");
      await createPipelineFailureIssue(command);
    }

    if (entries.length === 0) {
      setPhase("sending-success-email");
      await saveState({ status: "running", resultCount: 0 });
      console.log("🎉 No hay archivos por debajo del umbral de cobertura");
      await notifyEmail(
        `📊 [Symphony] Cobertura OK — ${new Date().toISOString().slice(0, 10)}`,
        `<h2>Cobertura validada</h2><p>No se detectaron archivos por debajo de ${COVERAGE_THRESHOLD}%.</p><p><strong>Coverage command ok:</strong> ${command.ok ? "sí" : "no"}</p>`
      );
      clearInterval(heartbeat);
      await saveState({ status: command.ok ? "completed" : "failed", phase: "done", resultCount: 0, error: command.errorMessage });
      if (!command.ok) process.exit(1);
      return;
    }

    console.log(`📉 ${entries.length} archivos por debajo de ${COVERAGE_THRESHOLD}%`);
    await createIssues(entries);

    setPhase("sending-summary-email");
    await saveState({ status: "running", resultCount: entries.length, error: command.errorMessage });
    const summary = entries.slice(0, 15).map((entry) => `<li><code>${entry.file}</code> — L${entry.lines}% / B${entry.branches}% / F${entry.functions}% / S${entry.statements}%</li>`).join("");
    await notifyEmail(
      `📉 [Symphony] Cobertura baja — ${entries.length} archivos`,
      `<h2>Archivos por debajo de ${COVERAGE_THRESHOLD}%</h2><p><strong>Total:</strong> ${entries.length}</p><p><strong>Coverage command ok:</strong> ${command.ok ? "sí" : "no"}</p><ul>${summary}</ul>`
    );

    clearInterval(heartbeat);
    await saveState({ status: command.ok ? "completed" : "failed", phase: "done", resultCount: entries.length, error: command.errorMessage });
    if (!command.ok) process.exit(1);
  } catch (err) {
    clearInterval(heartbeat);
    const reason = err instanceof Error ? err.stack ?? err.message : String(err);
    await saveState({ status: "failed", phase: "failed", error: reason });
    console.error("❌ Error en coverage auditor:", err);
    await notifyEmail(
      `❌ [Symphony] Coverage auditor fallido — ${new Date().toISOString().slice(0, 10)}`,
      `<h2>Coverage auditor fallido</h2><pre>${reason}</pre>`
    );
    process.exit(1);
  }
}

void main();
