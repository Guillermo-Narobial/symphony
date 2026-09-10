import "dotenv/config";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import { syncRepos } from "./repos.js";
import { fetchTasks } from "./fetcher.js";
import { processTask } from "./controller.js";
import { solveIssues } from "./solver.js";
import { reviewWatcher } from "./review-watcher.js";
import { findExisting } from "./issuer.js";
import { startStatusServer } from "./status-server.js";
import { startTelegramBot } from "./telegram-bot.js";

// --- PID Lockfile: prevent duplicate instances ---
const LOCKFILE = resolve(process.cwd(), ".symphony-agent.pid");

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(): void {
  if (existsSync(LOCKFILE)) {
    const existingPid = Number(readFileSync(LOCKFILE, "utf-8").trim());
    if (existingPid && isProcessAlive(existingPid)) {
      console.error(`❌ Ya hay una instancia corriendo (PID ${existingPid}). Abortando.`);
      process.exit(1);
    }
    // Stale lockfile — process is dead, remove it
    console.warn(`⚠️ Lockfile obsoleto (PID ${existingPid} muerto). Limpiando.`);
    unlinkSync(LOCKFILE);
  }
  writeFileSync(LOCKFILE, String(process.pid));
}

function releaseLock(): void {
  try { unlinkSync(LOCKFILE); } catch { /* ignore */ }
}

acquireLock();

// Clean up on exit
process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(0); });
process.on("SIGTERM", () => { releaseLock(); process.exit(0); });

// --user <usuario> override (default: gcalleja via env/config)
const userIdx = process.argv.indexOf("--user");
if (userIdx !== -1 && process.argv[userIdx + 1]) {
  config.dmsSearchValue = process.argv[userIdx + 1];
}

// --only <id> filter: process only the task with this id
const onlyIdx = process.argv.indexOf("--only");
const onlyId = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : undefined;

const INTERVAL_MS = 60 * 60_000; // una hora

async function tick() {
  try {
    // 1. Extraer incidencias del DMS sin sincronizar repos innecesariamente
    let tasks = await fetchTasks();
    console.log(`📋 Recibidas ${tasks.length} tareas del DMS`);

    // Filtrar por --only si se proporcionó
    if (onlyId) {
      tasks = tasks.filter((t: any) => t.id === onlyId);
      console.log(`🔍 Filtrado a ${tasks.length} tarea(s) con id=${onlyId}`);
    }

    // Filtrar: solo tareas con un único resource asignado a gcalleja o nagent
    tasks = tasks.filter((t: any) => {
      const r = t.resources;
      return Array.isArray(r) && r.length === 1 && (r[0].resourceId === "gcalleja" || r[0].resourceId === "nagent");
    });
    console.log(`🎯 ${tasks.length} tarea(s) asignadas a gcalleja/nagent`);

    const newTasks: typeof tasks = [];
    for (const task of tasks) {
      const taskId = String((task as { id?: unknown }).id ?? "");
      const existingIssue = await findExisting(taskId);
      if (existingIssue) {
        console.log("⏭️ Tarea " + taskId + ": issue #" + existingIssue + " ya existe; no se sincronizan repos");
      } else {
        newTasks.push(task);
      }
    }
    tasks = newTasks;

    // Solo sincronizamos los repos si hay tareas DMS nuevas que procesar.
    if (tasks.length > 0) {
      await syncRepos();
      console.log("✅ Repos sincronizados para procesar tareas nuevas");
    }

    // 2. Crear issues en GitHub para cada tarea nueva
    for (const task of tasks) {
      await processTask(task);
    }

    // 3. Detectar issues abiertas y lanzar agentes para resolverlas
    await solveIssues();
  } catch (err) {
    console.error("❌ Error en tick:", err);
  }
}

console.log("🚀 Orquestador iniciado");
startStatusServer();
startTelegramBot();
await tick();
setInterval(tick, INTERVAL_MS);

// Review watcher: cada 10 min revisa issues en-revision con feedback
const REVIEW_INTERVAL_MS = Number(process.env.REVIEW_WATCH_INTERVAL_MS ?? 30 * 60_000);
let reviewWatcherRunning = false;
setInterval(async () => {
  if (reviewWatcherRunning) {
    console.log("⏳ Review watcher anterior aún está en curso; se omite esta ronda");
    return;
  }
  reviewWatcherRunning = true;
  try { await reviewWatcher(); } catch (err) { console.error("❌ Error en reviewWatcher:", err); }
  finally { reviewWatcherRunning = false; }
}, REVIEW_INTERVAL_MS);
