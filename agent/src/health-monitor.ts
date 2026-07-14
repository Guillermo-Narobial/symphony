import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { AGENT_ENV } from "./agent-executor.js";
import { config } from "./config.js";
import { notifyEmail } from "./notifier-email.js";
import { branchNameForIssue } from "./runner.js";

const exec = promisify(execFile);

const STUCK_MINUTES = Number(process.env.AGENT_STUCK_MINUTES ?? "45");
const ALERT_COOLDOWN_MINUTES = Number(process.env.AGENT_HEALTH_ALERT_COOLDOWN_MINUTES ?? "60");
const DASHBOARD_HTML = resolve(process.env.AGENT_HEALTH_DASHBOARD_HTML ?? "./docs/agent-health.html");
const DASHBOARD_JSON = resolve(process.env.AGENT_HEALTH_DASHBOARD_JSON ?? "./docs/agent-health.json");
const STATE_FILE = resolve(process.env.AGENT_HEALTH_STATE_FILE ?? "./.health-monitor-state.json");

interface Issue {
  number: number;
  title: string;
  body: string;
  updatedAt: string;
  labels: string[];
}

interface PullRequest {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  url: string;
}

interface ServiceHealth {
  name: string;
  active: boolean;
  status: string;
  enabledStatus: string;
}

interface HealthAlert {
  title: string;
  detail: string;
}

interface HealthSnapshot {
  generatedAt: string;
  stuckThresholdMinutes: number;
  services: ServiceHealth[];
  processingIssues: Issue[];
  stuckIssues: Issue[];
  failedIssues: Issue[];
  openPullRequests: PullRequest[];
  alerts: HealthAlert[];
}

async function systemctlIsActive(service: string): Promise<ServiceHealth> {
  let enabledStatus = "unknown";
  try {
    const { stdout } = await exec("systemctl", ["is-enabled", service], { env: AGENT_ENV });
    enabledStatus = stdout.trim();
  } catch (err: any) {
    enabledStatus = String(err.stdout || err.message || "unknown").trim();
  }

  try {
    const { stdout } = await exec("systemctl", ["is-active", service], { env: AGENT_ENV });
    const status = stdout.trim();
    return { name: service, active: status === "active", status, enabledStatus };
  } catch (err: any) {
    const status = String(err.stdout || err.message || "unknown").trim();
    return { name: service, active: false, status, enabledStatus };
  }
}

async function fetchIssues(label: string): Promise<Issue[]> {
  const { stdout } = await exec("gh", [
    "issue", "list",
    "-R", config.repo,
    "--state", "open",
    "--label", label,
    "--json", "number,title,body,updatedAt,labels",
    "--limit", "100",
  ], { env: AGENT_ENV });

  const raw = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    body: string | null;
    updatedAt: string;
    labels: Array<{ name: string }>;
  }>;

  return raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    updatedAt: issue.updatedAt,
    labels: issue.labels.map((label) => label.name),
  }));
}

async function fetchOpenPullRequests(): Promise<PullRequest[]> {
  const { stdout } = await exec("gh", [
    "pr", "list",
    "-R", config.repo,
    "--state", "open",
    "--json", "number,title,body,headRefName,url",
    "--limit", "100",
  ], { env: AGENT_ENV });

  return JSON.parse(stdout) as PullRequest[];
}

function issueHasOpenPr(issue: Issue, prs: PullRequest[]): boolean {
  const branch = branchNameForIssue(issue.number, issue.title);
  return prs.some((pr) => {
    const body = pr.body ?? "";
    return pr.headRefName === branch
      || body.includes(`#${issue.number}`)
      || body.includes(`/issues/${issue.number}`)
      || pr.title.includes(branch);
  });
}

function retryAttempt(labels: string[]): number {
  const label = labels.find((name) => name.startsWith("agent-retry:"));
  return label ? Number(label.slice("agent-retry:".length)) || 0 : 0;
}

function staleProcessingIssues(issues: Issue[], prs: PullRequest[]): Issue[] {
  const thresholdMs = STUCK_MINUTES * 60_000;
  const now = Date.now();

  return issues.filter((issue) => {
    const updatedAt = new Date(issue.updatedAt).getTime();
    return Number.isFinite(updatedAt)
      && now - updatedAt >= thresholdMs
      && !issueHasOpenPr(issue, prs);
  });
}

function buildAlerts(snapshot: Omit<HealthSnapshot, "alerts">): HealthAlert[] {
  const alerts: HealthAlert[] = [];

  for (const service of snapshot.services) {
    if (!service.active) {
      alerts.push({
        title: `${service.name} no está activo`,
        detail: `Estado systemd: ${service.status}; habilitacion: ${service.enabledStatus}`,
      });
    }
  }

  for (const issue of snapshot.stuckIssues) {
    alerts.push({
      title: `Issue #${issue.number} atascada con ${config.processingLabel}`,
      detail: `${issue.title} — sin PR abierta y sin cambios desde ${issue.updatedAt}`,
    });
  }

  for (const issue of snapshot.failedIssues) {
    const attempt = retryAttempt(issue.labels);
    if (attempt >= config.maxAgentRetries) {
      alerts.push({
        title: `Issue #${issue.number} agotó reintentos`,
        detail: `${issue.title} — agent-retry:${attempt}/${config.maxAgentRetries}`,
      });
    }
  }

  return alerts;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderIssueRows(issues: Issue[]): string {
  if (issues.length === 0) return "<tr><td colspan=\"4\">Sin incidencias</td></tr>";

  return issues.map((issue) => `
    <tr>
      <td><a href="https://github.com/${config.repo}/issues/${issue.number}">#${issue.number}</a></td>
      <td>${escapeHtml(issue.title)}</td>
      <td>${escapeHtml(issue.updatedAt)}</td>
      <td>${escapeHtml(issue.labels.join(", "))}</td>
    </tr>
  `).join("");
}

function renderDashboard(snapshot: HealthSnapshot): string {
  const serviceItems = snapshot.services.map((service) => `
    <li class="${service.active ? "ok" : "bad"}">${escapeHtml(service.name)}: ${escapeHtml(service.status)} (${escapeHtml(service.enabledStatus)})</li>
  `).join("");
  const alertItems = snapshot.alerts.length === 0
    ? "<li class=\"ok\">Sin alertas activas</li>"
    : snapshot.alerts.map((alert) => `<li class="bad"><strong>${escapeHtml(alert.title)}</strong><br>${escapeHtml(alert.detail)}</li>`).join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Symphony Agent Health</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 32px; color: #172033; background: #f7f8fb; }
    main { max-width: 1180px; margin: 0 auto; }
    section { margin: 24px 0; }
    table { width: 100%; border-collapse: collapse; background: white; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #d9deea; text-align: left; vertical-align: top; }
    th { background: #edf1f8; }
    .ok { color: #17633a; }
    .bad { color: #9b1c1c; }
    .meta { color: #56637a; }
  </style>
</head>
<body>
<main>
  <h1>Symphony Agent Health</h1>
  <p class="meta">Generado: ${escapeHtml(snapshot.generatedAt)}. Umbral stuck: ${snapshot.stuckThresholdMinutes} min.</p>
  <section>
    <h2>Alertas</h2>
    <ul>${alertItems}</ul>
  </section>
  <section>
    <h2>Servicios</h2>
    <ul>${serviceItems}</ul>
  </section>
  <section>
    <h2>Issues Atascadas</h2>
    <table><thead><tr><th>Issue</th><th>Título</th><th>Updated</th><th>Labels</th></tr></thead><tbody>${renderIssueRows(snapshot.stuckIssues)}</tbody></table>
  </section>
  <section>
    <h2>Issues En Proceso</h2>
    <table><thead><tr><th>Issue</th><th>Título</th><th>Updated</th><th>Labels</th></tr></thead><tbody>${renderIssueRows(snapshot.processingIssues)}</tbody></table>
  </section>
</main>
</body>
</html>`;
}

async function readLastAlertState(): Promise<{ signature?: string; sentAt?: string }> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function shouldSendAlert(signature: string): Promise<boolean> {
  const state = await readLastAlertState();
  if (state.signature !== signature) return true;
  if (!state.sentAt) return true;

  const sentAt = new Date(state.sentAt).getTime();
  return !Number.isFinite(sentAt)
    || Date.now() - sentAt >= ALERT_COOLDOWN_MINUTES * 60_000;
}

async function persistSnapshot(snapshot: HealthSnapshot): Promise<void> {
  await mkdir(dirname(DASHBOARD_JSON), { recursive: true });
  await writeFile(DASHBOARD_JSON, JSON.stringify(snapshot, null, 2));
  await mkdir(dirname(DASHBOARD_HTML), { recursive: true });
  await writeFile(DASHBOARD_HTML, renderDashboard(snapshot));
}

async function notifyIfNeeded(snapshot: HealthSnapshot): Promise<void> {
  if (snapshot.alerts.length === 0) return;

  const signature = JSON.stringify(snapshot.alerts.map((alert) => alert.title).sort());
  if (!(await shouldSendAlert(signature))) {
    console.log("🔕 Alertas sin cambios dentro del cooldown");
    return;
  }

  const html = `
    <h2>🚨 Symphony Agent Health</h2>
    <p>Generado: ${snapshot.generatedAt}</p>
    <ul>
      ${snapshot.alerts.map((alert) => `<li><strong>${escapeHtml(alert.title)}</strong><br>${escapeHtml(alert.detail)}</li>`).join("")}
    </ul>
    <p>Dashboard local: <code>${DASHBOARD_HTML}</code></p>
  `;

  await notifyEmail(`🚨 [Symphony] Monitor agente — ${snapshot.alerts.length} alerta(s)`, html);
  await writeFile(STATE_FILE, JSON.stringify({ signature, sentAt: new Date().toISOString() }, null, 2));
}

async function main(): Promise<void> {
  console.log("🩺 Symphony health monitor — inicio");

  const [services, processingIssues, failedIssues, openPullRequests] = await Promise.all([
    Promise.all([
      systemctlIsActive("symphony-agent.service"),
    ]),
    fetchIssues(config.processingLabel),
    fetchIssues("agent-failed"),
    fetchOpenPullRequests(),
  ]);

  const baseSnapshot = {
    generatedAt: new Date().toISOString(),
    stuckThresholdMinutes: STUCK_MINUTES,
    services,
    processingIssues,
    stuckIssues: staleProcessingIssues(processingIssues, openPullRequests),
    failedIssues,
    openPullRequests,
  };
  const snapshot: HealthSnapshot = {
    ...baseSnapshot,
    alerts: buildAlerts(baseSnapshot),
  };

  await persistSnapshot(snapshot);
  await notifyIfNeeded(snapshot);

  console.log(`🩺 Monitor finalizado: ${snapshot.alerts.length} alerta(s)`);
}

main().catch((err) => {
  console.error("❌ Error en health monitor:", err);
  process.exit(1);
});
