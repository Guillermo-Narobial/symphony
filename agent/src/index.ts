import "dotenv/config";
import { config } from "./config.js";
import { syncRepos } from "./repos.js";
import { fetchTasks } from "./fetcher.js";
import { processTask } from "./controller.js";
import { solveIssues } from "./solver.js";
import { reviewWatcher } from "./review-watcher.js";

// --user <usuario> override (default: gcalleja via env/config)
const userIdx = process.argv.indexOf("--user");
if (userIdx !== -1 && process.argv[userIdx + 1]) {
  config.dmsSearchValue = process.argv[userIdx + 1];
}

// --only <id> filter: process only the task with this id
const onlyIdx = process.argv.indexOf("--only");
const onlyId = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : undefined;

const INTERVAL_MS = 5 * 60_000; // 5 minutos

async function tick() {
  try {
    // 1. Sincronizar repos
    await syncRepos();
    console.log("✅ Repos sincronizados");

    // 2. Extraer incidencias del DMS
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

    // 3. Crear issues en GitHub para cada tarea nueva
    for (const task of tasks) {
      await processTask(task);
    }

    // 4. Detectar issues abiertas y lanzar agentes para resolverlas
    await solveIssues();
  } catch (err) {
    console.error("❌ Error en tick:", err);
  }
}

console.log("🚀 Orquestador iniciado");
await tick();
setInterval(tick, INTERVAL_MS);

// Review watcher: cada 10 min revisa issues en-revision con feedback
const REVIEW_INTERVAL_MS = 10 * 60_000;
setInterval(async () => {
  try { await reviewWatcher(); } catch (err) { console.error("❌ Error en reviewWatcher:", err); }
}, REVIEW_INTERVAL_MS);
