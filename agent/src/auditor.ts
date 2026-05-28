import "dotenv/config";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { config } from "./config.js";
import { buildAuditPrompt } from "./audit-prompt.js";
import { notifyEmail } from "./notifier-email.js";

const exec = promisify(execFile);

interface Finding {
  title: string;
  category: string;
  severity: string;
  file: string;
  line?: number;
  description: string;
}

const LABEL_MAP: Record<string, string> = {
  security: "audit:security",
  "memory-leak": "audit:memory-leak",
  convention: "audit:convention",
  bug: "audit:bug",
  ui: "audit:ui",
};

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\].*?\x07|\x1B\[?\??[0-9;]*[hlm]/g, "");
}

function extractJson(raw: string): Finding[] {
  const clean = stripAnsi(raw);
  // Buscar bloque ```json ... ```
  const fenced = clean.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1].trim());
  // Buscar array JSON standalone (último match para evitar logs previos)
  const arrays = [...clean.matchAll(/(\[\s*\{[\s\S]*?\}\s*\])/g)];
  if (arrays.length > 0) return JSON.parse(arrays[arrays.length - 1][1]);
  throw new Error("No se encontró JSON en el output de kiro-cli");
}

async function ensureLabel(label: string): Promise<void> {
  try {
    await exec("gh", ["label", "create", label, "-R", config.repo, "--color", "D4C5F9"], { timeout: 10_000 });
  } catch { /* ya existe */ }
}

async function issueExists(title: string): Promise<boolean> {
  const { stdout } = await exec("gh", [
    "issue", "list", "-R", config.repo,
    "--state", "all", "--search", `"${title}" in:title`,
    "--json", "number", "--limit", "5",
  ]);
  return JSON.parse(stdout).length > 0;
}

async function createIssueFromFinding(finding: Finding): Promise<string | null> {
  const title = `[audit/${finding.category}] ${finding.title}`;

  if (await issueExists(title)) {
    console.log(`⏭️  Ya existe: ${title}`);
    return null;
  }

  const label = LABEL_MAP[finding.category] || "audit";
  await ensureLabel(label);
  await ensureLabel("audit");

  const body = `## Auditoría automática

**Categoría:** ${finding.category}
**Severidad:** ${finding.severity}
**Archivo:** \`${finding.file}\`${finding.line ? ` (línea ${finding.line})` : ""}

## Descripción

${finding.description}

## Instrucciones para el agente

- Corrige únicamente el problema descrito.
- Añade o actualiza el spec relacionado.
- Ejecuta \`npm run test:unit:staged\` antes del commit.

---
_Generado automáticamente por symphony-agent auditor._`;

  const { stdout } = await exec("gh", [
    "issue", "create", "-R", config.repo,
    "--title", title,
    "--body", body,
    "--label", `${label},audit`,
    "--assignee", config.rejectAssignee,
  ]);

  return stdout.trim();
}

async function runGitleaks(workDir: string): Promise<Finding[]> {
  console.log("🔑 Ejecutando gitleaks...");
  try {
    const { stdout } = await exec("gitleaks", ["detect", "--source", workDir, "--report-format", "json", "--report-path", "/dev/stdout", "--no-banner"], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const leaks = JSON.parse(stdout || "[]") as Array<{ Description: string; File: string; StartLine: number; Secret: string; RuleID: string }>;
    return leaks.map((l) => ({
      title: `Secret expuesto: ${l.RuleID}`,
      category: "security",
      severity: "critical",
      file: l.File,
      line: l.StartLine,
      description: `gitleaks detectó un secret (${l.Description}) en este archivo. Regla: ${l.RuleID}. Rota el secret inmediatamente y elimínalo del historial de git.`,
    }));
  } catch (err: any) {
    // Exit code 1 = leaks found (output en stdout)
    if (err.stdout) {
      try {
        const leaks = JSON.parse(err.stdout) as Array<{ Description: string; File: string; StartLine: number; RuleID: string }>;
        return leaks.map((l) => ({
          title: `Secret expuesto: ${l.RuleID}`,
          category: "security",
          severity: "critical",
          file: l.File,
          line: l.StartLine,
          description: `gitleaks detectó un secret (${l.Description}) en este archivo. Regla: ${l.RuleID}. Rota el secret inmediatamente y elimínalo del historial de git.`,
        }));
      } catch { /* parse error */ }
    }
    console.log("  ✅ gitleaks: sin secrets detectados");
    return [];
  }
}

async function checkNpmAuditCritical(workDir: string): Promise<Finding[]> {
  console.log("🛡️ Verificando npm audit (critical/high)...");
  try {
    const { stdout } = await exec("npm", ["audit", "--json"], { cwd: workDir, timeout: 60_000 });
    return parseAuditFindings(JSON.parse(stdout));
  } catch (err: any) {
    if (err.stdout) return parseAuditFindings(JSON.parse(err.stdout));
    return [];
  }
}

function parseAuditFindings(data: any): Finding[] {
  if (!data.vulnerabilities) return [];
  return Object.entries(data.vulnerabilities)
    .filter(([, v]: [string, any]) => v.severity === "critical" || v.severity === "high")
    .map(([name, v]: [string, any]) => ({
      title: `Vulnerabilidad ${v.severity} en ${name}`,
      category: "security",
      severity: v.severity === "critical" ? "critical" : "high",
      file: "package.json",
      description: `npm audit: ${v.via?.[0]?.title || v.via?.[0] || "vulnerabilidad conocida"} en ${name}@${v.range || "?"}. ${typeof v.fixAvailable === "object" ? `Fix: actualizar a ${v.fixAvailable.name}@${v.fixAvailable.version}` : v.fixAvailable ? "Fix automático disponible (npm audit fix)" : "Sin fix automático — evaluar alternativa."}`,
    }));
}

async function runAudit(): Promise<void> {
  const workDir = resolve(config.frontendRepoDir);
  const prompt = buildAuditPrompt();

  console.log("🔍 Lanzando auditoría semanal...");

  // Paso 1: gitleaks + npm audit (herramientas reales)
  const gitleaksFindings = await runGitleaks(workDir);
  const npmFindings = await checkNpmAuditCritical(workDir);
  const toolFindings = [...gitleaksFindings, ...npmFindings];

  if (toolFindings.length > 0) {
    console.log(`🚨 ${toolFindings.length} findings de herramientas (gitleaks + npm audit)`);
    for (const finding of toolFindings) {
      const url = await createIssueFromFinding(finding);
      if (url) console.log(`✅ Creada: ${url}`);
    }
  }

  // Paso 2: análisis con kiro-cli (revisión de código profunda)

  const output = await new Promise<string>((ok, fail) => {
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

  let findings: Finding[];
  try {
    findings = extractJson(output);
  } catch (err) {
    console.error("❌ No se pudo parsear el output:", err);
    console.error("Raw output (primeros 2000 chars):", output.slice(0, 2000));
    process.exit(1);
  }

  console.log(`📋 ${findings.length} findings detectados`);

  let created = 0;
  for (const finding of findings) {
    const url = await createIssueFromFinding(finding);
    if (url) { console.log(`✅ Creada: ${url}`); created++; }
  }

  await notifyEmail(
    `🛡️ [Symphony] auditor completado — ${new Date().toISOString().slice(0, 10)}`,
    `<h2>🛡️ Auditoría de código completada</h2><ul><li><b>Findings totales:</b> ${findings.length}</li><li><b>Issues nuevas creadas:</b> ${created}</li></ul>`
  );

  console.log("🏁 Auditoría completada");
}

runAudit().catch((err) => {
  console.error("❌ Error en auditoría:", err);
  process.exit(1);
});
