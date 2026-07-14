import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { config } from "./config.js";
import { notifyRejectionEmail } from "./notifier-email.js";

const exec = promisify(execFile);

const WORK_DIR = resolve(config.frontendRepoDir);
const COVERAGE_THRESHOLD = 85; // %
const MAX_ISSUES_PER_MODULE = 3;
const ISSUES_WINDOW_DAYS = 14;
const PR_STALE_HOURS = 48;

interface Alert {
  emoji: string;
  title: string;
  detail: string;
}

async function checkCoverage(): Promise<Alert[]> {
  console.log("📊 Verificando cobertura...");
  try {
    await exec("npx", ["vitest", "run", "--coverage", "--reporter=json"], {
      cwd: WORK_DIR, timeout: 300_000, maxBuffer: 50 * 1024 * 1024,
    });
  } catch { /* vitest puede salir != 0 pero generar coverage */ }

  try {
    const raw = await readFile(resolve(WORK_DIR, "coverage/coverage-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    const total = summary.total;
    const alerts: Alert[] = [];

    for (const metric of ["lines", "branches", "functions"] as const) {
      const pct = total[metric]?.pct ?? 100;
      if (pct < COVERAGE_THRESHOLD) {
        alerts.push({
          emoji: "📉",
          title: `Cobertura de ${metric} bajo umbral`,
          detail: `${metric}: ${pct}% (umbral: ${COVERAGE_THRESHOLD}%)`,
        });
      }
    }
    return alerts;
  } catch {
    console.log("  ⚠️ No se pudo leer coverage-summary.json");
    return [];
  }
}

async function checkModuleIssues(): Promise<Alert[]> {
  console.log("🔥 Verificando acumulación de incidencias por módulo...");
  const since = new Date();
  since.setDate(since.getDate() - ISSUES_WINDOW_DAYS);

  const { stdout } = await exec("gh", [
    "issue", "list", "-R", config.repo,
    "--state", "open",
    "--json", "title,createdAt,labels",
    "--limit", "100",
  ]);

  const issues = JSON.parse(stdout) as Array<{ title: string; createdAt: string; labels: Array<{ name: string }> }>;
  const recent = issues.filter((i) => new Date(i.createdAt) >= since);

  // Extraer módulo del título (formato: "ID: descripción en módulo-x")
  const moduleCount = new Map<string, number>();
  for (const issue of recent) {
    const match = issue.title.match(/(?:en|in)\s+([\w-]+)/i) || issue.title.match(/(\w+-\w+)(?:\.component|\.service|\.module)/);
    const module = match?.[1] || "general";
    moduleCount.set(module, (moduleCount.get(module) || 0) + 1);
  }

  const alerts: Alert[] = [];
  for (const [module, count] of moduleCount) {
    if (count >= MAX_ISSUES_PER_MODULE) {
      alerts.push({
        emoji: "🔥",
        title: `Módulo "${module}" acumula ${count} incidencias`,
        detail: `${count} issues abiertas en los últimos ${ISSUES_WINDOW_DAYS} días. Posible deuda técnica o componente inestable.`,
      });
    }
  }
  return alerts;
}

async function checkStalePRs(): Promise<Alert[]> {
  console.log("⏰ Verificando PRs sin revisión...");
  const { stdout } = await exec("gh", [
    "pr", "list", "-R", config.repo,
    "--state", "open",
    "--json", "number,title,createdAt,reviewDecision,author,url",
    "--limit", "50",
  ]);

  const prs = JSON.parse(stdout) as Array<{
    number: number; title: string; createdAt: string;
    reviewDecision: string; author: { login: string }; url: string;
  }>;

  const now = Date.now();
  const alerts: Alert[] = [];

  for (const pr of prs) {
    if (pr.reviewDecision === "APPROVED") continue;
    const createdAt = new Date(pr.createdAt);
    const businessHours = getBusinessHours(createdAt, new Date());
    if (businessHours >= PR_STALE_HOURS) {
      alerts.push({
        emoji: "⏰",
        title: `PR #${pr.number} sin revisión (${Math.round(businessHours)}h laborables)`,
        detail: `"${pr.title}" por ${pr.author.login} — ${pr.url}`,
      });
    }
  }
  return alerts;
}

function getBusinessHours(from: Date, to: Date): number {
  let hours = 0;
  const cursor = new Date(from);
  while (cursor < to) {
    const day = cursor.getDay();
    // 0 = domingo, 6 = sábado
    if (day !== 0 && day !== 6) {
      hours++;
    }
    cursor.setTime(cursor.getTime() + 3600_000);
  }
  return hours;
}

async function main(): Promise<void> {
  console.log("🚨 Alertas proactivas — inicio");

  const allAlerts: Alert[] = [];

  const [coverage, modules, prs] = await Promise.allSettled([
    checkCoverage(),
    checkModuleIssues(),
    checkStalePRs(),
  ]);

  if (coverage.status === "fulfilled") allAlerts.push(...coverage.value);
  if (modules.status === "fulfilled") allAlerts.push(...modules.value);
  if (prs.status === "fulfilled") allAlerts.push(...prs.value);

  console.log(`🚨 ${allAlerts.length} alertas detectadas`);

  if (allAlerts.length === 0) {
    console.log("✅ Todo en orden");
    return;
  }

  const body = allAlerts.map((a) => `${a.emoji} **${a.title}**\n   ${a.detail}`).join("\n\n");

  await notifyRejectionEmail("ALERTAS",
    `🚨 Alertas proactivas — ${new Date().toISOString().slice(0, 10)}\n\n${body}`
  );

  console.log("📧 Email de alertas enviado");
}

main().catch((err) => {
  console.error("❌ Error en alertas:", err);
  process.exit(1);
});
