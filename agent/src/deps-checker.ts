import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { notifyEmail } from "./notifier-email.js";

const exec = promisify(execFile);

const LABEL = "deps:update";
const BRANCH_PREFIX = "deps/auto-update-";

interface AuditVuln {
  name: string;
  severity: string;
  title: string;
  url: string;
  range: string;
  fixAvailable: boolean | { name: string; version: string };
}

interface OutdatedPkg {
  current: string;
  wanted: string;
  latest: string;
  type: string;
  homepage?: string;
}

async function syncRepo(dir: string, branch: string): Promise<void> {
  await exec("git", ["fetch", "origin"], { cwd: dir });
  await exec("git", ["checkout", branch], { cwd: dir });
  await exec("git", ["pull", "origin", branch, "--ff-only"], { cwd: dir });
}

async function detectBaseBranch(dir: string, repoName: string): Promise<string> {
  if (repoName === "Narobial-Frontend") return "hotfix-master";

  try {
    const { stdout } = await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: dir });
    const remoteHead = stdout.trim();
    const branch = remoteHead.replace(/^origin\//, "");
    if (branch) return branch;
  } catch {
    // Fallbacks below cover repos without origin/HEAD configured locally.
  }

  for (const candidate of ["main", "master"]) {
    try {
      await exec("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`], { cwd: dir });
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(`No se pudo detectar la rama base de ${repoName}`);
}

function normalizeCommandError(err: any, repoName: string, step: string): Error {
  const message = err?.message || String(err);

  if (
    step === "npm ci" &&
    typeof message === "string" &&
    message.includes("EACCES") &&
    message.includes("node_modules")
  ) {
    return new Error(
      `${step} fallo en ${repoName} por permisos en node_modules. ` +
      "Probablemente hay archivos creados por root u otro usuario dentro del clon local."
    );
  }

  return err instanceof Error ? err : new Error(message);
}

async function installDependencies(dir: string, repoName: string): Promise<void> {
  try {
    await exec("npm", ["ci"], { cwd: dir, timeout: 120_000 });
  } catch (err: any) {
    throw normalizeCommandError(err, repoName, "npm ci");
  }
}

async function getOutdated(dir: string): Promise<Record<string, OutdatedPkg>> {
  try {
    const { stdout } = await exec("npm", ["outdated", "--json"], { cwd: dir });
    return JSON.parse(stdout);
  } catch (err: any) {
    // npm outdated exits 1 when there are outdated deps
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

async function getAudit(dir: string): Promise<AuditVuln[]> {
  try {
    const { stdout } = await exec("npm", ["audit", "--json"], { cwd: dir });
    const data = JSON.parse(stdout);
    return parseAuditVulns(data);
  } catch (err: any) {
    if (err.stdout) return parseAuditVulns(JSON.parse(err.stdout));
    throw err;
  }
}

function parseAuditVulns(data: any): AuditVuln[] {
  if (!data.vulnerabilities) return [];
  return Object.entries(data.vulnerabilities).map(([name, v]: [string, any]) => ({
    name,
    severity: v.severity,
    title: v.via?.[0]?.title || v.via?.[0] || "Unknown",
    url: v.via?.[0]?.url || "",
    range: v.range || "",
    fixAvailable: v.fixAvailable,
  }));
}

async function ensureLabel(repo: string): Promise<void> {
  try {
    await exec("gh", ["label", "create", LABEL, "-R", repo, "--color", "0E8A16", "--description", "Actualización automática de dependencias"], { timeout: 10_000 });
  } catch { /* ya existe */ }
}

async function prExists(repo: string, branch: string): Promise<boolean> {
  const { stdout } = await exec("gh", ["pr", "list", "-R", repo, "--head", branch, "--json", "number", "--limit", "1"]);
  return JSON.parse(stdout).length > 0;
}

async function createUpdatePR(repoUrl: string, dir: string, branch: string, outdated: Record<string, OutdatedPkg>, vulns: AuditVuln[]): Promise<string | null> {
  const repoSlug = repoUrl.replace("https://github.com/", "");
  const dateSuffix = new Date().toISOString().slice(0, 10);
  const prBranch = `${BRANCH_PREFIX}${dateSuffix}`;

  if (await prExists(repoSlug, prBranch)) {
    console.log(`⏭️  PR ya existe para ${repoSlug} (${prBranch})`);
    return null;
  }

  // Crear rama
  await exec("git", ["checkout", "-b", prBranch], { cwd: dir });

  // Actualizar deps (solo patch/minor seguras)
  await exec("npm", ["update"], { cwd: dir });

  // Intentar fix de vulnerabilidades
  try {
    await exec("npm", ["audit", "fix"], { cwd: dir });
  } catch { /* best effort */ }

  // Verificar si hay cambios
  const { stdout: diff } = await exec("git", ["diff", "--stat"], { cwd: dir });
  if (!diff.trim()) {
    console.log(`✅ ${repoSlug}: sin cambios pendientes`);
    await exec("git", ["checkout", branch], { cwd: dir });
    await exec("git", ["branch", "-D", prBranch], { cwd: dir });
    return null;
  }

  // Commit y push
  await exec("git", ["add", "package.json", "package-lock.json"], { cwd: dir });
  await exec("git", ["commit", "-m", `chore(deps): actualización automática de dependencias ${dateSuffix}`], { cwd: dir });
  await exec("git", ["push", "-u", "origin", prBranch], { cwd: dir });

  // Crear PR
  const body = buildPRBody(outdated, vulns);
  await ensureLabel(repoSlug);

  const { stdout: prUrl } = await exec("gh", [
    "pr", "create", "-R", repoSlug,
    "--base", branch,
    "--head", prBranch,
    "--title", `chore(deps): actualización automática ${dateSuffix}`,
    "--body", body,
    "--label", LABEL,
    "--assignee", config.rejectAssignee,
  ]);

  // Volver a la rama principal
  await exec("git", ["checkout", branch], { cwd: dir });

  return prUrl.trim();
}

function buildPRBody(outdated: Record<string, OutdatedPkg>, vulns: AuditVuln[]): string {
  const outdatedSection = Object.entries(outdated).slice(0, 20).map(([name, pkg]) =>
    `| ${name} | ${pkg.current} | ${pkg.wanted} | ${pkg.latest} | ${pkg.type} |`
  ).join("\n");

  const vulnSection = vulns.slice(0, 10).map((v) =>
    `| ${v.name} | ${v.severity} | ${v.title} | ${typeof v.fixAvailable === "object" ? `→ ${v.fixAvailable.version}` : v.fixAvailable ? "sí" : "no"} |`
  ).join("\n");

  return `## 📦 Actualización automática de dependencias

### Dependencias desactualizadas

| Paquete | Actual | Wanted | Latest | Tipo |
|---------|--------|--------|--------|------|
${outdatedSection || "| — | — | — | — | — |"}

### Vulnerabilidades detectadas (npm audit)

| Paquete | Severidad | Descripción | Fix disponible |
|---------|-----------|-------------|----------------|
${vulnSection || "| — | — | — | — |"}

### Acciones realizadas

- \`npm update\` (patch/minor)
- \`npm audit fix\` (vulnerabilidades con fix automático)

### Verificación requerida

- [ ] Tests pasan correctamente
- [ ] Build sin errores
- [ ] Revisar breaking changes en deps major

---
_Generado por symphony-agent deps-checker._`;
}

async function processRepo(repoUrl: string): Promise<Omit<RepoResult, "repo">> {
  const repoName = repoUrl.split("/").pop()!;
  const dir = resolve(config.reposDir, repoName);

  console.log(`\n📦 Procesando ${repoName}...`);

  if (!existsSync(dir)) {
    console.log(`  Clonando ${repoUrl}...`);
    await exec("git", ["clone", repoUrl, dir]);
  }

  const branch = await detectBaseBranch(dir, repoName);
  await syncRepo(dir, branch);
  await installDependencies(dir, repoName);

  const outdated = await getOutdated(dir);
  const vulns = await getAudit(dir);

  const outdatedCount = Object.keys(outdated).length;
  const criticalVulns = vulns.filter((v) => v.severity === "critical" || v.severity === "high");

  console.log(`  📊 ${outdatedCount} desactualizadas, ${vulns.length} vulnerabilidades (${criticalVulns.length} high/critical)`);

  if (outdatedCount === 0 && vulns.length === 0) {
    console.log(`  ✅ Todo al día`);
    return { outdated: 0, vulns: 0, critical: 0, prUrl: null };
  }

  const prUrl = await createUpdatePR(repoUrl, dir, branch, outdated, vulns);
  if (prUrl) console.log(`  🔗 PR creada: ${prUrl}`);

  return { outdated: outdatedCount, vulns: vulns.length, critical: criticalVulns.length, prUrl };
}

interface RepoResult {
  repo: string;
  outdated: number;
  vulns: number;
  critical: number;
  prUrl: string | null;
  error?: string;
}

async function notifySummary(results: RepoResult[]): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const title = `[deps] Resumen semanal ${date}`;

  const rows = results.map((r) => {
    const status = r.error ? "❌" : r.prUrl ? "🔄" : "✅";
    const pr = r.prUrl ? `[PR](${r.prUrl})` : "—";
    return `| ${status} | ${r.repo} | ${r.outdated} | ${r.vulns} (${r.critical} critical) | ${pr} |`;
  }).join("\n");

  const body = `## 📦 Análisis semanal de dependencias — ${date}

| Estado | Repo | Desactualizadas | Vulnerabilidades | PR |
|--------|------|-----------------|------------------|----|
${rows}

---
_Generado por symphony-agent deps-checker._`;

  await exec("gh", [
    "issue", "create", "-R", config.repo,
    "--title", title,
    "--body", body,
    "--label", LABEL,
    "--assignee", config.rejectAssignee,
  ]);
}

async function main(): Promise<void> {
  console.log("📦 Análisis semanal de dependencias — inicio");
  const results: RepoResult[] = [];

  for (const repoUrl of config.repos) {
    const repoName = repoUrl.split("/").pop()!;
    try {
      const result = await processRepo(repoUrl);
      results.push({ repo: repoName, ...result });
    } catch (err: any) {
      console.error(`❌ Error procesando ${repoUrl}:`, err);
      results.push({ repo: repoName, outdated: 0, vulns: 0, critical: 0, prUrl: null, error: err.message });
    }
  }

  await notifySummary(results);

  const emailRows = results.map((r) => {
    const status = r.error ? "❌" : "✅";
    return `<tr><td>${status}</td><td>${r.repo}</td><td>${r.outdated}</td><td>${r.vulns} (${r.critical} critical)</td><td>${r.error || "OK"}</td></tr>`;
  }).join("");
  await notifyEmail(
    `📦 [Symphony] deps-checker completado — ${new Date().toISOString().slice(0, 10)}`,
    `<h2>📦 Análisis de dependencias completado</h2><table border="1" cellpadding="6" style="border-collapse:collapse"><tr style="background:#f0f0f0"><th>Estado</th><th>Repo</th><th>Desactualizadas</th><th>Vulnerabilidades</th><th>Notas</th></tr>${emailRows}</table>`
  );

  console.log("\n🏁 Análisis de dependencias completado");
}

main().catch((err) => {
  console.error("❌ Error en deps-checker:", err);
  process.exit(1);
});
