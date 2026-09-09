/**
 * Symphony Agent — Telegram Bot
 *
 * Usa la API de Telegram con node:https nativo (sin dependencias).
 * Requiere TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en .env
 * Si no están configurados, no arranca (graceful skip).
 */
import { request as httpsRequest } from "node:https";
import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { getRunningIssues } from "./solver.js";
import { searchKnowledgeBase } from "./knowledge-base.js";
import { fetchQabiertos } from "./q700-query.js";
import { fetchHorarioEmpleado } from "./qusuarios-query.js";
import { fetchQfichaje } from "./qfichaje-query.js";
import nodemailer from "nodemailer";

const exec = promisify(execFile);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const HEALTH_JSON = resolve(process.env.AGENT_HEALTH_DASHBOARD_JSON ?? "./docs/agent-health.json");
const CHANGELOG_PATH = resolve(config.reposDir, "narobial-changelog", "CHANGELOG.md");
const POLL_INTERVAL_MS = 3_000;

let lastUpdateId = 0;

// --- Telegram API helpers ---

function telegramApi(method: string, body?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = httpsRequest(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          try { resolve(JSON.parse(chunks)); } catch { resolve(null); }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(chatId: string, text: string): Promise<void> {
  // Telegram max message length: 4096
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf("\n", maxLen);
    if (cutAt < maxLen / 2) cutAt = maxLen;
    parts.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }
  return parts;
}

// --- Command handlers ---

async function cmdStatus(): Promise<string> {
  const running = getRunningIssues();
  let msg = `🎵 *Symphony Agent Status*\n\n`;
  msg += `📊 Issues en vuelo: ${running.length}/${config.maxConcurrentAgents}\n`;
  if (running.length > 0) {
    msg += `   → ${running.map((n) => `#${n}`).join(", ")}\n`;
  }
  msg += `⚙️ Solver: ${config.solverCommand}\n`;
  msg += `🔄 Max retries: ${config.maxAgentRetries}\n`;

  try {
    const healthData = await readFile(HEALTH_JSON, "utf-8");
    const health = JSON.parse(healthData);
    if (health.alerts?.length) {
      msg += `\n⚠️ *Alertas:*\n`;
      for (const a of health.alerts.slice(0, 5)) {
        msg += `  • ${a.title}\n`;
      }
    } else {
      msg += `\n✅ Sin alertas activas`;
    }
  } catch {
    msg += `\n⚠️ Health data no disponible`;
  }

  return msg;
}

async function cmdSearch(query: string): Promise<string> {
  if (!query) return "❓ Uso: /search <texto>\nEjemplo: /search scheduler fichaje";
  const results = await searchKnowledgeBase(query, "", 3);
  if (!results) return `🔍 Sin resultados para: "${query}"`;
  // Limpiar markdown pesado para Telegram
  return `🔍 *Resultados para:* "${query}"\n\n${results.slice(0, 3500)}`;
}

async function cmdHistory(n: number): Promise<string> {
  try {
    const content = await readFile(CHANGELOG_PATH, "utf-8");
    const entries = content.split("\n").filter((l) => l.startsWith("- [")).slice(0, n);
    if (entries.length === 0) return "📜 Changelog vacío.";
    return `📜 *Últimas ${entries.length} entradas:*\n\n${entries.join("\n")}`;
  } catch {
    return "⚠️ Changelog no disponible.";
  }
}

async function cmdFailures(n: number): Promise<string> {
  try {
    const content = await readFile(CHANGELOG_PATH, "utf-8");
    const entries = content
      .split("\n")
      .filter((l) => l.startsWith("- ["))
      .filter((l) => {
        const lower = l.toLowerCase();
        return lower.includes("fail") || lower.includes("error") || lower.includes("falló") || lower.includes("rollback");
      })
      .slice(0, n);
    if (entries.length === 0) return "✅ Sin fallos recientes.";
    return `❌ *Últimos ${entries.length} fallos:*\n\n${entries.join("\n")}`;
  } catch {
    return "⚠️ Changelog no disponible.";
  }
}

function cmdHelp(): string {
  return `🎵 *Symphony Agent Bot*

Comandos disponibles:
/status — Estado del sistema
/search <texto> — Buscar en historial de decisiones
/history [n] — Últimas N entradas del changelog
/failures [n] — Últimos N fallos
/running — Issues en ejecución ahora
/prs — PRs abiertas en el repo
/Qabiertos — Q700 Narobial en estado Q1
/horarioEmpleado <nombre> — Horario de un empleado
/qfichaje <idp> — Último fichaje de un empleado por IDP
/config — Configuración activa
/email <dest> | <asunto> | <cuerpo> — Enviar email
/create <título> | <descripción> — Crear issue y lanzar agente
/validarprs <número_pr> — Aprobar y mergear PR con bypass
/help — Esta ayuda

Para /create, separa título y cuerpo con |
Ejemplo: /create Bug en scheduler | El planificador no muestra los fichajes del lunes`;
}

function cmdRunning(): string {
  const issues = getRunningIssues();
  if (issues.length === 0) return "💤 Sin issues en ejecución ahora.";
  return `🔄 *Issues en vuelo (${issues.length}/${config.maxConcurrentAgents}):*\n\n${issues.map((n) => `  • #${n}`).join("\n")}`;
}

function cmdConfig(): string {
  return `⚙️ *Configuración activa:*

• Repo: \`${config.repo}\`
• Solver: \`${config.solverCommand}\`
• Max concurrent: ${config.maxConcurrentAgents}
• Max retries: ${config.maxAgentRetries}
• Kiro→Codex tras: ${config.maxKiroAttemptsBeforeCodex} intentos
• Deploy: ${config.deployHost}`;
}

// --- Q700 abiertos (isNarobial + Q1) ---

async function cmdQabiertos(): Promise<string> {
  try {
    const items = await fetchQabiertos();

    if (items.length === 0) {
      return "📭 No hay Q700 disponibles (isNarobial en estado Q1) ahora mismo.";
    }

    let msg = `📋 *Q700 abiertos (Narobial · Q1) — ${items.length}:*\n\n`;
    for (const q of items) {
      const country = q.countryId ? ` [${q.countryId}]` : "";
      msg += `• \`${q.id}\`${country} — ${q.title}\n`;
    }
    return msg.slice(0, 3900);
  } catch (err) {
    return `❌ Error consultando Q700: ${(err as Error).message}`;
  }
}

// --- Horario de empleado (GET.QUSUARIOS) ---

async function cmdHorarioEmpleado(query: string): Promise<string> {
  if (!query) {
    return "❓ Uso: /horarioEmpleado <nombre>\nEjemplo: /horarioEmpleado Guillermo";
  }

  try {
    const empleados = await fetchHorarioEmpleado(query);

    if (empleados.length === 0) {
      return `🔍 Sin resultados para: "${query}"`;
    }

    let msg = `🕐 *Horario de empleados* ("${query}") — ${empleados.length}:\n\n`;
    for (const e of empleados) {
      msg += `👤 *${e.name ?? "—"}*\n`;
      msg += `   🕐 Horario: ${e.schedule ?? "no disponible"}\n`;
      if (e.email) msg += `   ✉️ ${e.email}\n`;
      if (e.telephone) msg += `   📞 Ext. ${e.telephone}\n`;
      msg += `\n`;
    }
    return msg.slice(0, 3900);
  } catch (err) {
    return `❌ Error consultando horario: ${(err as Error).message}`;
  }
}

// --- Último fichaje por IDP (GET.QFICHAJE) ---

async function cmdQfichaje(idp: string): Promise<string> {
  const clean = idp.trim();
  if (!clean) {
    return "❓ Uso: /qfichaje <idp>\nEjemplo: /qfichaje 23";
  }

  try {
    const result = await fetchQfichaje(clean);

    // Cerrado / sin fichaje hoy / idp inválido → mensaje del DMS
    if (!result.ok || !result.fichaje) {
      return `🕑 *Fichaje (IDP ${clean})*\n\nℹ️ ${result.message ?? "Sin datos de fichaje."}`;
    }

    const f = result.fichaje;
    const ci = f.checkIn?.[0];
    let msg = `🕑 *Fichaje (IDP ${clean})*\n\n`;
    msg += `${f.isCheckInActive ? "🟢 Fichaje activo" : "🔴 Fichaje cerrado"}\n`;
    if (f.id) msg += `📋 Tarea: \`${f.id}\`\n`;

    if (ci) {
      if (ci.dateIn || ci.timeIn) msg += `➡️ Entrada: ${ci.dateIn ?? ""} ${ci.timeIn ?? ""}\n`;
      if (ci.dateOut || ci.timeOut) msg += `⬅️ Salida: ${ci.dateOut ?? ""} ${ci.timeOut ?? ""}\n`;
    }

    const tipos: string[] = [];
    if (f.isCheckedInToProject) tipos.push("Proyecto");
    if (f.isCheckedInToQ700) tipos.push("Q700");
    if (f.isCheckedInToManualTask) tipos.push("Tarea manual");
    if (tipos.length > 0) msg += `🏷️ Tipo: ${tipos.join(", ")}\n`;

    return msg.slice(0, 3900);
  } catch (err) {
    return `❌ Error consultando fichaje: ${(err as Error).message}`;
  }
}

// --- Open Pull Requests ---

async function cmdPrs(filterUser?: string): Promise<string> {
  try {
    const args = [
      "pr", "list",
      "-R", config.repo,
      "--state", "open",
      "--json", "number,title,headRefName,url,author",
      "--limit", "30",
    ];
    if (filterUser) {
      args.push("--author", filterUser);
    }

    const { stdout } = await exec("gh", args);
    const prs = JSON.parse(stdout) as Array<{
      number: number;
      title: string;
      headRefName: string;
      url: string;
      author: { login: string };
    }>;

    if (prs.length === 0) {
      return filterUser
        ? `✅ No hay PRs abiertas de \`${filterUser}\`.`
        : "✅ No hay PRs abiertas.";
    }

    const header = filterUser
      ? `🔀 *PRs abiertas de* \`${filterUser}\` *(${prs.length}):*\n\n`
      : `🔀 *PRs abiertas (${prs.length}):*\n\n`;

    let msg = header;
    for (const pr of prs) {
      msg += `• #${pr.number} — ${pr.title}\n  ↳ \`${pr.headRefName}\` by ${pr.author?.login ?? "?"}\n  ${pr.url}\n\n`;
    }
    return msg.slice(0, 3900);
  } catch (err) {
    return `❌ Error consultando PRs: ${(err as Error).message}`;
  }
}

// --- Create issue via API ---

async function cmdCreate(input: string): Promise<string> {
  if (!input || !input.includes("|")) {
    return `❓ Uso: /create <título> | <descripción>
Ejemplo: /create Bug en scheduler | El planificador no muestra fichajes del lunes

Opciones avanzadas (añadir al final):
  --type=bug|feature|refactor
  --no-solve (no lanzar agente automáticamente)`;
  }

  const [titlePart, ...bodyParts] = input.split("|");
  let title = titlePart.trim();
  let body = bodyParts.join("|").trim();

  // Parse opciones
  let type: "bug" | "feature" | "refactor" = "bug";
  let autoSolve = true;

  if (body.includes("--type=feature")) { type = "feature"; body = body.replace("--type=feature", "").trim(); }
  else if (body.includes("--type=refactor")) { type = "refactor"; body = body.replace("--type=refactor", "").trim(); }
  else if (body.includes("--type=bug")) { type = "bug"; body = body.replace("--type=bug", "").trim(); }

  if (body.includes("--no-solve")) { autoSolve = false; body = body.replace("--no-solve", "").trim(); }

  if (!title) return "❌ El título no puede estar vacío.";
  if (!body) body = title;

  try {
    const response = await fetch(`http://localhost:4040/api/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, type, autoSolve }),
    });
    const data = await response.json() as { success?: boolean; url?: string; number?: number; message?: string; error?: string };

    if (data.success) {
      return `✅ *Issue creada*

🔗 ${data.url}
📋 #${data.number}
${autoSolve ? "🚀 Agente lanzado automáticamente" : "⏸️ Sin auto-solve"}

${data.message}`;
    } else {
      return `❌ Error: ${data.error ?? "desconocido"}`;
    }
  } catch (err) {
    return `❌ Error conectando con API: ${(err as Error).message}`;
  }
}

// --- Send email ---

async function cmdEmail(input: string): Promise<string> {
  // Formato: /email destinatario | asunto | cuerpo
  if (!input || !input.includes("|")) {
    return `❓ Uso: /email <destinatario> | <asunto> | <cuerpo>
Ejemplo: /email jaime.garcia@narobial.net | Prueba | Hola, esto es una prueba

Puedes enviar a varios separando con coma:
/email user1@narobial.net, user2@narobial.net | Asunto | Cuerpo`;
  }

  const parts = input.split("|").map((p) => p.trim());
  if (parts.length < 3) {
    return "❌ Formato incorrecto. Necesitas: destinatario | asunto | cuerpo";
  }

  const [toPart, subject, ...bodyParts] = parts;
  const body = bodyParts.join("|").trim();
  const recipients = toPart.split(",").map((r) => r.trim()).filter(Boolean);

  if (recipients.length === 0) return "❌ No se indicó destinatario.";
  if (!subject) return "❌ El asunto no puede estar vacío.";

  const transporter = nodemailer.createTransport({
    host: "smtp-relay.gmail.com",
    port: 465,
    secure: true,
  });

  const results: string[] = [];
  for (const to of recipients) {
    try {
      await transporter.sendMail({
        from: "noreply@narobial.net",
        to,
        subject,
        html: `<p>${body.replace(/\n/g, "<br>")}</p><p><small>Enviado desde Symphony Bot</small></p>`,
      });
      results.push(`✅ ${to}`);
    } catch (err) {
      results.push(`❌ ${to}: ${(err as Error).message}`);
    }
  }

  transporter.close();
  return `📧 *Resultado del envío:*\n\n${results.join("\n")}`;
}

// --- Validar PRs (approve + merge with admin bypass) ---

async function cmdValidarPrs(input: string): Promise<string> {
  const prNumber = input.trim();

  if (!prNumber || !/^\d+$/.test(prNumber)) {
    return `❓ Uso: /validarprs <número_pr>\nEjemplo: /validarprs 1140\n\nAprueba y mergea la PR con bypass de branch protection rules.`;
  }

  try {
    // Step 1: Approve the PR
    await exec("gh", [
      "pr", "review", prNumber,
      "--approve",
      "-R", config.repo,
    ]);

    // Step 2: Merge with --admin to bypass branch protection + delete branch
    const { stdout } = await exec("gh", [
      "pr", "merge", prNumber,
      "--merge",
      "--admin",
      "--delete-branch",
      "-R", config.repo,
    ]);

    return `✅ *PR #${prNumber} validada y mergeada*\n\n🔓 Bypass de branch protection aplicado\n🗑️ Rama eliminada\n📋 Repo: \`${config.repo}\`\n\n${stdout.trim()}`;
  } catch (err) {
    const errMsg = (err as Error).message || String(err);
    // Check if approve succeeded but merge failed
    if (errMsg.includes("merge")) {
      return `⚠️ PR #${prNumber}: Aprobada pero falló el merge.\n\nError: ${errMsg}`;
    }
    return `❌ Error validando PR #${prNumber}:\n${errMsg}`;
  }
}

// --- Natural language intent detection ---

interface DetectedIntent {
  command: string;
  args?: string;
}

function detectIntent(text: string): DetectedIntent | null {
  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // PRs
  if (/\bprs?\b|pull.?requests?|merge.?requests?/.test(lower)) {
    // Check if it's a "validar/aprobar/mergear" intent first
    if (/\bvalida(?:r)?\b|\baproba(?:r)?\b|\bmergea(?:r)?\b|\bbypass\b|\bfusiona(?:r)?\b/.test(lower)) {
      const prMatch = lower.match(/(\d+)/);
      return { command: "/validarprs", args: prMatch?.[1] };
    }
    // Detect user filter: "prs de pablo", "prs que tiene juan", "prs abiertas por maria"
    const userMatch = lower.match(/(?:prs?|pull.?requests?)\s+(?:de|del?|que tiene|abiert[ao]s?\s+por|por|from)\s+(\w+)/);
    return { command: "/prs", args: userMatch?.[1] };
  }

  // Validar PRs (sin mención explícita de "pr")
  if (/\bvalida(?:r)?\b.*\d+|\baproba(?:r)?\b.*\d+|\bmergea(?:r)?\b.*\d+/.test(lower)) {
    const prMatch = lower.match(/(\d+)/);
    if (prMatch) return { command: "/validarprs", args: prMatch[1] };
  }

  // Status
  if (/\bestado\b|\bstatus\b|\bcomo\s+(?:va|esta|anda)/.test(lower)) {
    return { command: "/status" };
  }

  // Running
  if (/\bcorriendo\b|\bejecutando\b|\brunning\b|\ben\s+vuelo\b|\bprocesando\b/.test(lower)) {
    return { command: "/running" };
  }

  // History
  if (/\bhistorial\b|\bhistory\b|\bchangelog\b|\bultim[ao]s?\s+(?:cambios|entradas)/.test(lower)) {
    const nMatch = lower.match(/(\d+)/);
    return { command: "/history", args: nMatch?.[1] };
  }

  // Failures
  if (/\bfallos?\b|\bfailures?\b|\berrores?\b|\bfails?\b/.test(lower)) {
    const nMatch = lower.match(/(\d+)/);
    return { command: "/failures", args: nMatch?.[1] };
  }

  // Config
  if (/\bconfig(?:uracion)?\b|\bconfiguracion\b/.test(lower)) {
    return { command: "/config" };
  }

  // Help
  if (/\bayuda\b|\bhelp\b|\bcomandos\b/.test(lower)) {
    return { command: "/help" };
  }

  // Search (explicit)
  if (/\bbusca(?:r)?\b|\bsearch\b|\bencontrar\b/.test(lower)) {
    const query = text.replace(/^.*?(?:buscar?|search|encontrar)\s*/i, "").trim();
    return { command: "/search", args: query || undefined };
  }

  return null;
}

// --- LLM via Codex CLI (gpt-5.4-mini, usa sesión OAuth local) ---

const LLM_MODEL = process.env.BOT_LLM_MODEL ?? "gpt-5.4-mini";

const SYSTEM_PROMPT = `Eres el asistente del equipo Narobial. Respondes en español de forma breve y útil.
Tienes acceso a estos comandos del bot:
- /status — estado del sistema
- /prs [usuario] — PRs abiertas (filtrable por autor)
- /running — issues en ejecución
- /search <texto> — buscar en historial
- /history [n] — changelog
- /failures [n] — fallos recientes
- /config — configuración
- /email <dest> | <asunto> | <cuerpo> — enviar email
- /create <título> | <descripción> — crear issue

Si el usuario quiere ejecutar una acción, responde SOLO con el comando en formato:
CMD: /comando args

Si es una pregunta general o conversación, responde directamente sin CMD.
No uses markdown pesado, responde en texto plano.`;

function callLLM(userMessage: string): Promise<string | null> {
  const prompt = `${SYSTEM_PROMPT}\n\nUsuario: ${userMessage}`;
  const outputFile = `/tmp/bot-llm-${Date.now()}.txt`;
  const promptFile = `/tmp/bot-prompt-${Date.now()}.txt`;

  return new Promise((resolve) => {
    // Write prompt to file, then pipe it to codex exec
    writeFile(promptFile, prompt, "utf-8")
      .then(() => {
        execFile("bash", [
          "-c",
          `codex exec -m "${LLM_MODEL}" -o "${outputFile}" --skip-git-repo-check --ephemeral - < "${promptFile}"`,
        ], { timeout: 30_000 }, (err) => {
          // Cleanup prompt file
          unlink(promptFile).catch(() => {});

          if (err) {
            unlink(outputFile).catch(() => {});
            resolve(null);
            return;
          }
          readFile(outputFile, "utf-8")
            .then((content) => {
              unlink(outputFile).catch(() => {});
              resolve(content.trim() || null);
            })
            .catch(() => resolve(null));
        });
      })
      .catch(() => resolve(null));
  });
}

async function handleNaturalLanguage(chatId: string, text: string): Promise<void> {
  // Directo al LLM (gpt-5.4-mini via Codex CLI)
  const llmResponse = await callLLM(text);
  if (!llmResponse) {
    await sendMessage(chatId, "⚠️ No pude procesar tu mensaje. Verifica que Codex CLI está autenticado.");
    return;
  }

  // Check if LLM returned a command
  const cmdMatch = llmResponse.match(/^CMD:\s*(\/\S+.*)$/m);
  if (cmdMatch) {
    await handleMessage(chatId, cmdMatch[1].trim());
  } else {
    await sendMessage(chatId, llmResponse);
  }
}

// --- Message dispatcher ---

async function handleMessage(chatId: string, text: string): Promise<void> {
  // Security: only respond to allowed chat
  if (ALLOWED_CHAT_ID && chatId !== ALLOWED_CHAT_ID) {
    await sendMessage(chatId, "🚫 No autorizado. Tu chat ID: " + chatId);
    return;
  }

  const trimmed = text.trim();
  const [cmd, ...args] = trimmed.split(/\s+/);
  const argStr = args.join(" ");

  let response: string;

  switch (cmd.toLowerCase()) {
    case "/start":
    case "/help":
      response = cmdHelp();
      break;
    case "/status":
      response = await cmdStatus();
      break;
    case "/search":
      response = await cmdSearch(argStr);
      break;
    case "/history":
      response = await cmdHistory(Number(args[0]) || 10);
      break;
    case "/failures":
      response = await cmdFailures(Number(args[0]) || 5);
      break;
    case "/running":
      response = cmdRunning();
      break;
    case "/config":
      response = cmdConfig();
      break;
    case "/qabiertos":
      response = await cmdQabiertos();
      break;
    case "/horarioempleado":
      response = await cmdHorarioEmpleado(argStr);
      break;
    case "/qfichaje":
      response = await cmdQfichaje(argStr);
      break;
    case "/prs":
      response = await cmdPrs(argStr || undefined);
      break;
    case "/create":
      response = await cmdCreate(argStr);
      break;
    case "/email":
      response = await cmdEmail(argStr);
      break;
    case "/validarprs":
      response = await cmdValidarPrs(argStr);
      break;
    default:
      // Si no es un comando, usar detección de intenciones + LLM fallback
      if (trimmed.startsWith("/")) {
        response = `❓ Comando desconocido. Escribe /help para ver opciones.`;
      } else {
        await handleNaturalLanguage(chatId, trimmed);
        return;
      }
  }

  await sendMessage(chatId, response);
}

// --- Polling loop ---

async function pollUpdates(): Promise<void> {
  try {
    const data = await telegramApi("getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ["message"],
    });

    if (!data?.ok || !data.result?.length) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg?.text) continue;
      const chatId = String(msg.chat.id);
      await handleMessage(chatId, msg.text).catch((err) => {
        console.error("Telegram handler error:", err);
      });
    }
  } catch (err) {
    console.error("Telegram poll error:", err);
  }
}

// --- Public API ---

export function startTelegramBot(): void {
  if (!BOT_TOKEN) {
    console.log("📱 Telegram bot: TELEGRAM_BOT_TOKEN no configurado — skipping");
    return;
  }

  console.log(`📱 Telegram bot: iniciado${ALLOWED_CHAT_ID ? ` (chat restringido: ${ALLOWED_CHAT_ID})` : " (sin restricción de chat)"}`);

  // Register commands menu in Telegram
  telegramApi("setMyCommands", {
    commands: [
      { command: "status", description: "Estado del sistema" },
      { command: "prs", description: "PRs abiertas en el repo" },
      { command: "qabiertos", description: "Q700 Narobial en estado Q1" },
      { command: "horarioempleado", description: "Horario de un empleado (por nombre)" },
      { command: "qfichaje", description: "Último fichaje de un empleado (por IDP)" },
      { command: "running", description: "Issues en ejecución ahora" },
      { command: "search", description: "Buscar en historial de decisiones" },
      { command: "history", description: "Últimas N entradas del changelog" },
      { command: "failures", description: "Últimos N fallos" },
      { command: "config", description: "Configuración activa" },
      { command: "email", description: "Enviar email (dest | asunto | cuerpo)" },
      { command: "create", description: "Crear issue y lanzar agente" },
      { command: "validarprs", description: "Aprobar y mergear PR con bypass" },
      { command: "help", description: "Mostrar ayuda" },
    ],
  }).catch(() => { /* non-critical */ });

  // Start polling
  const poll = async () => {
    await pollUpdates();
    setTimeout(poll, POLL_INTERVAL_MS);
  };
  poll();
}
