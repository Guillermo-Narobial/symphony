#!/usr/bin/env node
import "dotenv/config";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { searchKnowledgeBase } from "./knowledge-base.js";

const exec = promisify(execFile);

const CHANGELOG_PATH = resolve(config.reposDir, "narobial-changelog", "CHANGELOG.md");
const HEALTH_JSON = resolve(process.env.AGENT_HEALTH_DASHBOARD_JSON ?? "./docs/agent-health.json");

// --- Helpers ---

function printHeader(): void {
  console.log(`
╔══════════════════════════════════════════╗
║  🎵  Symphony Agent — Chatbot CLI       ║
╚══════════════════════════════════════════╝
  Escribe 'help' para ver comandos disponibles.
`);
}

function printHelp(): void {
  console.log(`
Comandos disponibles:
  status          — Resumen del sistema (servicios, issues, config)
  search <texto>  — Buscar en historial de decisiones
  history [n]     — Últimas N entradas del changelog (default: 10)
  issue <número>  — Buscar info de una issue concreta
  failures [n]    — Últimos N fallos registrados (default: 10)
  timers          — Estado de systemd timers
  config          — Configuración activa del agente
  help            — Mostrar esta ayuda
  exit            — Salir
`);
}

async function readChangelog(): Promise<string[]> {
  try {
    const content = await readFile(CHANGELOG_PATH, "utf-8");
    return content.split("\n").filter((line) => line.startsWith("- ["));
  } catch {
    return [];
  }
}

async function readHealth(): Promise<any> {
  try {
    const data = await readFile(HEALTH_JSON, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// --- Commands ---

async function cmdStatus(): Promise<void> {
  const health = await readHealth();

  console.log("\n── Estado del Sistema ──\n");

  if (health) {
    console.log(`Generado: ${health.generatedAt ?? "desconocido"}`);
    console.log(`Umbral stuck: ${health.stuckThresholdMinutes ?? 45} min`);

    if (health.services?.length) {
      console.log("\nServicios:");
      for (const s of health.services) {
        const icon = s.active ? "✅" : "❌";
        console.log(`  ${icon} ${s.name}: ${s.status} (${s.enabledStatus})`);
      }
    }

    if (health.alerts?.length) {
      console.log("\n⚠️  Alertas:");
      for (const a of health.alerts) {
        console.log(`  • ${a.title}: ${a.detail}`);
      }
    } else {
      console.log("\n✅ Sin alertas activas");
    }

    if (health.processingIssues?.length) {
      console.log("\n🔄 Issues en proceso:");
      for (const i of health.processingIssues) {
        console.log(`  #${i.number}: ${i.title}`);
      }
    }

    if (health.stuckIssues?.length) {
      console.log("\n⏰ Issues atascadas:");
      for (const i of health.stuckIssues) {
        console.log(`  #${i.number}: ${i.title} (última actualización: ${i.updatedAt})`);
      }
    }
  } else {
    console.log("  ⚠️  Health data no disponible");
  }

  console.log("\n── Config ──");
  console.log(`  Repo: ${config.repo}`);
  console.log(`  Solver: ${config.solverCommand}`);
  console.log(`  Max concurrent: ${config.maxConcurrentAgents}`);
  console.log(`  Max retries: ${config.maxAgentRetries}`);
  console.log("");
}

async function cmdSearch(query: string): Promise<void> {
  if (!query) {
    console.log("  Uso: search <texto>");
    return;
  }
  console.log(`\n🔍 Buscando: "${query}"...\n`);
  const results = await searchKnowledgeBase(query, "", 5);
  if (results) {
    console.log(results);
  } else {
    console.log("  Sin resultados.");
  }
  console.log("");
}

async function cmdHistory(n: number): Promise<void> {
  const entries = await readChangelog();
  const slice = entries.slice(0, n);
  console.log(`\n📜 Últimas ${slice.length} entradas del changelog:\n`);
  for (const entry of slice) {
    console.log(`  ${entry}`);
  }
  if (entries.length > n) {
    console.log(`  ... (${entries.length - n} más)`);
  }
  console.log("");
}

async function cmdIssue(number: string): Promise<void> {
  if (!number) {
    console.log("  Uso: issue <número>");
    return;
  }
  const entries = await readChangelog();
  const matching = entries.filter((e) => e.includes(`#${number}`) || e.includes(`-${number}-`));

  console.log(`\n🔍 Issue #${number} en changelog:\n`);
  if (matching.length === 0) {
    console.log("  No se encontraron entradas.");
  } else {
    for (const entry of matching.slice(0, 20)) {
      console.log(`  ${entry}`);
    }
  }

  // Also search decisions
  const decisions = await searchKnowledgeBase(`issue ${number}`, number, 3);
  if (decisions) {
    console.log("\n📚 Decisiones relacionadas:\n");
    console.log(decisions);
  }
  console.log("");
}

async function cmdFailures(n: number): Promise<void> {
  const entries = await readChangelog();
  const failures = entries.filter((e) => {
    const lower = e.toLowerCase();
    return lower.includes("fail") || lower.includes("error") || lower.includes("falló") || lower.includes("rollback");
  });
  const slice = failures.slice(0, n);

  console.log(`\n❌ Últimos ${slice.length} fallos registrados:\n`);
  if (slice.length === 0) {
    console.log("  Sin fallos recientes en changelog.");
  } else {
    for (const entry of slice) {
      console.log(`  ${entry}`);
    }
  }
  console.log("");
}

async function cmdTimers(): Promise<void> {
  console.log("\n⏱️  Timers de systemd:\n");
  try {
    const { stdout } = await exec("systemctl", ["list-timers", "--user", "--no-pager"], { timeout: 10_000 });
    const lines = stdout.split("\n").filter((l) => l.includes("symphony") || l.includes("NEXT") || l.includes("ACTIVATES"));
    if (lines.length > 0) {
      for (const line of lines) {
        console.log(`  ${line}`);
      }
    } else {
      console.log("  Sin timers symphony encontrados (puede que corran como system, no user).");
      // Try system-level
      try {
        const { stdout: sysOut } = await exec("systemctl", ["list-timers", "--no-pager"], { timeout: 10_000 });
        const sysLines = sysOut.split("\n").filter((l) => l.includes("symphony"));
        for (const line of sysLines) {
          console.log(`  ${line}`);
        }
      } catch {}
    }
  } catch (err) {
    console.log(`  Error obteniendo timers: ${(err as Error).message}`);
  }
  console.log("");
}

function cmdConfig(): void {
  console.log("\n⚙️  Configuración activa:\n");
  console.log(`  Repo:                 ${config.repo}`);
  console.log(`  Solver:               ${config.solverCommand}`);
  console.log(`  Max concurrent:       ${config.maxConcurrentAgents}`);
  console.log(`  Max retries:          ${config.maxAgentRetries}`);
  console.log(`  Kiro→Codex tras:      ${config.maxKiroAttemptsBeforeCodex} intentos`);
  console.log(`  Processing label:     ${config.processingLabel}`);
  console.log(`  Deploy host:          ${config.deployHost}`);
  console.log(`  Frontend dir:         ${config.frontendRepoDir}`);
  console.log(`  Workspaces dir:       ${config.agentWorkspacesDir}`);
  console.log("");
}

// --- Main loop ---

async function processCommand(input: string): Promise<boolean> {
  const trimmed = input.trim();
  if (!trimmed) return true;

  const [cmd, ...args] = trimmed.split(/\s+/);
  const argStr = args.join(" ");

  switch (cmd.toLowerCase()) {
    case "exit":
    case "quit":
    case "q":
      console.log("👋 Hasta luego.");
      return false;
    case "help":
    case "?":
      printHelp();
      break;
    case "status":
      await cmdStatus();
      break;
    case "search":
      await cmdSearch(argStr);
      break;
    case "history":
      await cmdHistory(Number(args[0]) || 10);
      break;
    case "issue":
      await cmdIssue(args[0] ?? "");
      break;
    case "failures":
      await cmdFailures(Number(args[0]) || 10);
      break;
    case "timers":
      await cmdTimers();
      break;
    case "config":
      cmdConfig();
      break;
    default:
      console.log(`  ❓ Comando desconocido: "${cmd}". Escribe 'help' para ver opciones.`);
  }

  return true;
}

// --- Entry point ---

printHeader();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "symphony> ",
});

rl.prompt();

rl.on("line", async (line) => {
  const shouldContinue = await processCommand(line);
  if (!shouldContinue) {
    rl.close();
    process.exit(0);
  }
  rl.prompt();
});

rl.on("close", () => {
  process.exit(0);
});
