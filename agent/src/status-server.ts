import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { getRunningIssues } from "./solver.js";
import { solveIssues } from "./solver.js";
import { searchKnowledgeBase } from "./knowledge-base.js";

const exec = promisify(execFile);

const PORT = Number(process.env.STATUS_SERVER_PORT ?? "4040");
const HOST = process.env.STATUS_SERVER_HOST ?? "127.0.0.1";
const API_TOKEN = process.env.STATUS_SERVER_TOKEN;
const HEALTH_JSON = resolve(process.env.AGENT_HEALTH_DASHBOARD_JSON ?? "./docs/agent-health.json");
const CHANGELOG_PATH = resolve(config.reposDir, "narobial-changelog", "CHANGELOG.md");

function cors(res: ServerResponse): void {
  res.setHeader("Vary", "Origin");
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!API_TOKEN) return false;
  const authorization = req.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const token = req.headers["x-status-token"] ?? bearer;
  return typeof token === "string" && token === API_TOKEN;
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function html(res: ServerResponse, body: string): void {
  cors(res);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function errorJson(res: ServerResponse, message: string, status = 500): void {
  json(res, { error: message }, status);
}

function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf("?");
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : "");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// --- Handlers ---

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await readFile(HEALTH_JSON, "utf-8");
    json(res, JSON.parse(data));
  } catch {
    errorJson(res, "Health data not available", 503);
  }
}

function handleRunning(_req: IncomingMessage, res: ServerResponse): void {
  json(res, { running: getRunningIssues(), count: getRunningIssues().length, maxConcurrent: config.maxConcurrentAgents });
}

async function handleTimers(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { stdout } = await exec("systemctl", ["list-timers", "--user", "--no-pager", "--output=json"], { timeout: 10_000 });
    json(res, JSON.parse(stdout));
  } catch {
    // Fallback: parse text output
    try {
      const { stdout } = await exec("systemctl", ["list-timers", "--user", "--no-pager"], { timeout: 10_000 });
      const lines = stdout.trim().split("\n").filter((l) => l.includes("symphony"));
      json(res, { timers: lines, raw: true });
    } catch (err) {
      errorJson(res, `Timers unavailable: ${(err as Error).message}`, 503);
    }
  }
}

async function handleDecisions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = parseQuery(req.url ?? "");
  const q = query.get("q") ?? "";
  if (!q) {
    json(res, { error: "Missing ?q= parameter" }, 400);
    return;
  }
  const results = await searchKnowledgeBase(q, "", 10);
  json(res, { query: q, results: results || "No results found" });
}

async function handleChangelog(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = parseQuery(req.url ?? "");
  const limit = Math.min(Number(query.get("limit") ?? "30"), 200);
  const offset = Number(query.get("offset") ?? "0");

  try {
    const content = await readFile(CHANGELOG_PATH, "utf-8");
    const entries = content
      .split("\n")
      .filter((line) => line.startsWith("- ["))
      .slice(offset, offset + limit);
    json(res, { total: content.split("\n").filter((l) => l.startsWith("- [")).length, offset, limit, entries });
  } catch {
    errorJson(res, "Changelog not available", 503);
  }
}

function handleConfig(_req: IncomingMessage, res: ServerResponse): void {
  json(res, {
    repo: config.repo,
    maxConcurrentAgents: config.maxConcurrentAgents,
    maxAgentRetries: config.maxAgentRetries,
    maxKiroAttemptsBeforeCodex: config.maxKiroAttemptsBeforeCodex,
    solverCommand: config.solverCommand,
    processingLabel: config.processingLabel,
    deployHost: config.deployHost,
    frontendRepoDir: config.frontendRepoDir,
  });
}

// --- POST /api/issues — Crear issue y lanzar agente ---

interface CreateIssueRequest {
  title: string;
  body: string;
  labels?: string[];
  type?: "bug" | "feature" | "refactor";
  autoSolve?: boolean;
}

async function handleCreateIssue(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthorized(req)) {
    errorJson(res, "Issue creation API is disabled or unauthorized", 403);
    return;
  }

  if (req.method !== "POST") {
    errorJson(res, "Method not allowed. Use POST.", 405);
    return;
  }

  let payload: CreateIssueRequest;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw) as CreateIssueRequest;
  } catch {
    errorJson(res, "Invalid JSON body", 400);
    return;
  }

  if (!payload.title || !payload.body) {
    errorJson(res, "Missing required fields: title, body", 400);
    return;
  }

  try {
    // Crear la issue en GitHub
    const labels = payload.labels ?? [];
    if (payload.type === "bug") labels.push("bug");
    if (payload.type === "feature") labels.push("feature");
    if (payload.type === "refactor") labels.push("refactor");
    labels.push("ai-generated");

    const ghArgs = [
      "issue", "create",
      "-R", config.repo,
      "--title", payload.title,
      "--body", payload.body,
      "--assignee", config.rejectAssignee,
    ];
    for (const l of labels) ghArgs.push("--label", l);

    const { stdout } = await exec("gh", ghArgs, { env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN } });
    const issueUrl = stdout.trim();
    const numberMatch = issueUrl.match(/issues\/(\d+)/);
    const issueNumber = numberMatch ? Number(numberMatch[1]) : null;

    console.log(`📝 Issue creada via API: ${issueUrl}`);

    // Lanzar solver si autoSolve (default: true)
    const shouldSolve = payload.autoSolve !== false;
    if (shouldSolve) {
      console.log(`🚀 Lanzando solver para issue recién creada...`);
      // Trigger solve cycle asíncronamente
      solveIssues().catch((err) => console.error("Error en solveIssues post-create:", err));
    }

    json(res, {
      success: true,
      url: issueUrl,
      number: issueNumber,
      autoSolve: shouldSolve,
      message: shouldSolve
        ? `Issue creada y solver lanzado. El agente la procesará en el próximo ciclo.`
        : `Issue creada. No se lanzó solver automático.`,
    }, 201);
  } catch (err) {
    errorJson(res, `Failed to create issue: ${(err as Error).message}`, 500);
  }
}

// --- Dashboard HTML ---

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Symphony Agent — Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 1.8rem; margin-bottom: 8px; color: #60a5fa; }
    .meta { color: #64748b; font-size: 0.85rem; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; margin-bottom: 24px; }
    .card { background: #1e2130; border: 1px solid #2d3348; border-radius: 12px; padding: 20px; }
    .card h2 { font-size: 1rem; color: #94a3b8; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat { font-size: 2.2rem; font-weight: 700; color: #34d399; }
    .stat.warn { color: #fbbf24; }
    .stat.bad { color: #f87171; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-ok { background: #064e3b; color: #34d399; }
    .badge-warn { background: #78350f; color: #fbbf24; }
    .badge-bad { background: #7f1d1d; color: #f87171; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #2d3348; font-size: 0.85rem; }
    th { color: #64748b; font-weight: 600; }
    .entry { padding: 6px 0; border-bottom: 1px solid #1e2130; font-size: 0.82rem; color: #cbd5e1; }
    #search-input { width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid #2d3348; background: #161824; color: #e2e8f0; font-size: 0.9rem; margin-bottom: 12px; }
    #search-input:focus { outline: none; border-color: #60a5fa; }
    #search-results { max-height: 300px; overflow-y: auto; }
    .refresh-note { text-align: center; color: #475569; font-size: 0.75rem; margin-top: 20px; }
  </style>
</head>
<body>
<div class="container">
  <h1>🎵 Symphony Agent</h1>
  <p class="meta">Dashboard operativo — <span id="ts">cargando...</span></p>

  <div class="grid">
    <div class="card">
      <h2>Issues en vuelo</h2>
      <div id="running-stat" class="stat">—</div>
      <div id="running-list" style="margin-top:8px;font-size:0.82rem;color:#94a3b8;"></div>
    </div>
    <div class="card">
      <h2>Configuración</h2>
      <div id="config-info" style="font-size:0.82rem;color:#94a3b8;"></div>
    </div>
    <div class="card">
      <h2>Servicios</h2>
      <div id="services-list"></div>
    </div>
    <div class="card">
      <h2>Alertas</h2>
      <div id="alerts-list"></div>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px;">
    <h2>Últimas ejecuciones</h2>
    <div id="changelog-entries"></div>
  </div>

  <div class="card" style="margin-bottom:20px;">
    <h2>Buscar decisiones</h2>
    <input id="search-input" type="text" placeholder="Buscar en historial de decisiones..." />
    <div id="search-results"></div>
  </div>

  <p class="refresh-note">Auto-refresh cada 30s</p>
</div>
<script>
const API = '';

async function fetchJson(path) {
  try { const r = await fetch(API + path); return await r.json(); } catch { return null; }
}

async function refresh() {
  const [running, health, cfg, changelog] = await Promise.all([
    fetchJson('/api/running'),
    fetchJson('/api/health'),
    fetchJson('/api/config'),
    fetchJson('/api/changelog?limit=15'),
  ]);

  document.getElementById('ts').textContent = new Date().toLocaleString('es-ES');

  if (running) {
    const el = document.getElementById('running-stat');
    el.textContent = running.count + ' / ' + running.maxConcurrent;
    el.className = 'stat' + (running.count > 0 ? ' warn' : '');
    document.getElementById('running-list').textContent = running.running.length > 0
      ? 'Issues: ' + running.running.map(n => '#' + n).join(', ')
      : 'Sin issues activas';
  }

  if (cfg) {
    document.getElementById('config-info').innerHTML =
      '<div>Repo: ' + cfg.repo + '</div>' +
      '<div>Solver: ' + cfg.solverCommand + '</div>' +
      '<div>Max retries: ' + cfg.maxAgentRetries + '</div>' +
      '<div>Kiro→Codex tras: ' + cfg.maxKiroAttemptsBeforeCodex + ' intentos</div>';
  }

  if (health) {
    const services = health.services || [];
    document.getElementById('services-list').innerHTML = services.map(s =>
      '<div style="margin:4px 0;"><span class="badge ' + (s.active ? 'badge-ok' : 'badge-bad') + '">' +
      (s.active ? 'OK' : 'DOWN') + '</span> ' + s.name + '</div>'
    ).join('') || '<div style="color:#64748b;">Sin datos</div>';

    const alerts = health.alerts || [];
    document.getElementById('alerts-list').innerHTML = alerts.length > 0
      ? alerts.map(a => '<div style="margin:4px 0;color:#f87171;">⚠ ' + a.title + '</div>').join('')
      : '<div style="color:#34d399;">✓ Sin alertas</div>';
  }

  if (changelog && changelog.entries) {
    document.getElementById('changelog-entries').innerHTML = changelog.entries.slice(0, 15)
      .map(e => '<div class="entry">' + e + '</div>').join('');
  }
}

let searchTimeout;
document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  if (q.length < 3) { document.getElementById('search-results').innerHTML = ''; return; }
  searchTimeout = setTimeout(async () => {
    const data = await fetchJson('/api/decisions?q=' + encodeURIComponent(q));
    if (data && data.results) {
      document.getElementById('search-results').innerHTML =
        '<div style="white-space:pre-wrap;font-size:0.8rem;color:#94a3b8;max-height:300px;overflow-y:auto;">' +
        (typeof data.results === 'string' ? data.results : JSON.stringify(data.results, null, 2)) + '</div>';
    }
  }, 500);
});

refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;
}

// --- Router ---

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    switch (path) {
      case "/":
        html(res, dashboardHtml());
        break;
      case "/api/health":
        await handleHealth(req, res);
        break;
      case "/api/running":
        handleRunning(req, res);
        break;
      case "/api/timers":
        await handleTimers(req, res);
        break;
      case "/api/decisions":
        await handleDecisions(req, res);
        break;
      case "/api/changelog":
        await handleChangelog(req, res);
        break;
      case "/api/config":
        handleConfig(req, res);
        break;
      case "/api/issues":
        await handleCreateIssue(req, res);
        break;
      default:
        errorJson(res, "Not found", 404);
    }
  } catch (err) {
    console.error("Status server error:", err);
    errorJson(res, "Internal error", 500);
  }
}

export function startStatusServer(): void {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Unhandled status server error:", err);
      if (!res.headersSent) errorJson(res, "Internal error", 500);
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`⚠️ Status server: puerto ${PORT} ocupado — continuando sin status server`);
    } else {
      console.error("❌ Status server error:", err);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`📊 Status server: http://${HOST}:${PORT}`);
  });
}
