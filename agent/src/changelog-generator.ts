import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { notifyRejectionEmail } from "./notifier-email.js";

const exec = promisify(execFile);

const CHANGELOG_DIR = resolve(config.reposDir, "narobial-changelog");
const FRONTEND_DIR = resolve(config.frontendRepoDir);
const RELEASE_NOTES_FILE = "RELEASE-NOTES.md";

interface ChangeEntry {
  date: string;
  type: string;
  branch: string;
  description: string;
  project: string;
  author: string;
}

async function syncRepos(): Promise<void> {
  for (const dir of [CHANGELOG_DIR, FRONTEND_DIR]) {
    await exec("git", ["fetch", "origin"], { cwd: dir });
    const { stdout } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
    const branch = stdout.trim();
    await exec("git", ["pull", "origin", branch, "--ff-only"], { cwd: dir });
  }
}

async function getAuthorsMap(): Promise<Map<string, string>> {
  // Mapear rama → autor desde los commits del frontend
  const { stdout } = await exec("git", [
    "log", "--since=7.days", "--all", "--pretty=format:%an|%D",
  ], { cwd: FRONTEND_DIR, maxBuffer: 10 * 1024 * 1024 });

  const map = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [author, refs] = line.split("|");
    if (!author || !refs) continue;
    const branches = refs.split(",").map((r) => r.trim().replace("origin/", ""));
    for (const branch of branches) {
      if (branch && !map.has(branch)) map.set(branch, author);
    }
  }

  // También mapear por commits directos con branch en mensaje
  const { stdout: logByBranch } = await exec("git", [
    "log", "--since=30.days", "--all", "--pretty=format:%an|%s",
  ], { cwd: FRONTEND_DIR, maxBuffer: 10 * 1024 * 1024 });

  for (const line of logByBranch.split("\n")) {
    const [author, msg] = line.split("|");
    if (!author || !msg) continue;
    // Extraer rama del mensaje de merge o del commit convencional
    const mergeMatch = msg.match(/Merge.*?['"]?(\w+\/[\w-]+)/);
    if (mergeMatch && !map.has(mergeMatch[1])) map.set(mergeMatch[1], author);
  }

  return map;
}

async function getRecentChanges(): Promise<ChangeEntry[]> {
  const content = await readFile(resolve(CHANGELOG_DIR, "CHANGELOG.md"), "utf-8");
  const lines = content.split("\n").filter((l) => l.startsWith("- ["));

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoff = sevenDaysAgo.toISOString().slice(0, 10);

  const authorsMap = await getAuthorsMap();
  const entries: ChangeEntry[] = [];

  for (const line of lines) {
    const match = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s+(\w+)\s+([\w/.-]+)\s+[—–-]\s+(.+?)\s*\|\s*(.+)$/);
    if (!match) continue;

    const [, date, type, branch, description, project] = match;
    if (date < cutoff) break; // CHANGELOG está ordenado por fecha desc

    const author = authorsMap.get(branch) || findAuthorByBranch(authorsMap, branch);
    entries.push({ date, type, branch, description, project: project.trim(), author });
  }

  return entries;
}

function findAuthorByBranch(map: Map<string, string>, branch: string): string {
  // Buscar coincidencia parcial
  for (const [key, author] of map) {
    if (key.includes(branch) || branch.includes(key)) return author;
  }
  return "Equipo Narobial";
}

function generateReleaseNotes(entries: ChangeEntry[]): string {
  const date = new Date().toISOString().slice(0, 10);

  // Agrupar por categoría legible
  const categories: Record<string, ChangeEntry[]> = {};
  const categoryNames: Record<string, string> = {
    FEAT: "✨ Nuevas funcionalidades",
    FIX: "🐛 Correcciones",
    REFACTOR: "♻️ Mejoras internas",
    STYLE: "🎨 Mejoras visuales",
    DOCS: "📝 Documentación",
    BUILD: "🔧 Infraestructura",
    MERGE: "🔀 Integraciones",
    REVERT: "⏪ Reversiones",
  };

  for (const entry of entries) {
    const cat = categoryNames[entry.type] || "📦 Otros";
    (categories[cat] ??= []).push(entry);
  }

  // Generar markdown legible
  let md = `# 📋 Release Notes — Semana del ${date}\n\n`;
  md += `> Resumen semanal de cambios en los proyectos Narobial para stakeholders.\n\n`;

  // Resumen ejecutivo
  const feats = entries.filter((e) => e.type === "FEAT").length;
  const fixes = entries.filter((e) => e.type === "FIX").length;
  const total = entries.length;
  md += `## 📊 Resumen\n\n`;
  md += `- **${total}** cambios esta semana\n`;
  md += `- **${feats}** nuevas funcionalidades\n`;
  md += `- **${fixes}** correcciones de errores\n`;

  // Autores
  const authors = [...new Set(entries.map((e) => e.author))];
  md += `- **Contribuidores:** ${authors.join(", ")}\n\n`;

  // Detalle por categoría
  for (const [category, items] of Object.entries(categories)) {
    md += `## ${category}\n\n`;
    for (const item of items) {
      md += `- ${item.description} _(${item.author}, ${item.date})_\n`;
    }
    md += "\n";
  }

  md += `---\n_Generado automáticamente por symphony-agent changelog-generator._\n`;
  return md;
}

async function publishReleaseNotes(content: string): Promise<void> {
  const filePath = resolve(CHANGELOG_DIR, RELEASE_NOTES_FILE);
  await writeFile(filePath, content);

  const { stdout: diff } = await exec("git", ["diff", "--stat"], { cwd: CHANGELOG_DIR });
  if (!diff.trim()) return;

  const date = new Date().toISOString().slice(0, 10);
  await exec("git", ["add", RELEASE_NOTES_FILE], { cwd: CHANGELOG_DIR });
  await exec("git", ["commit", "-m", `docs: release notes semana ${date}`], { cwd: CHANGELOG_DIR });
  await exec("git", ["push"], { cwd: CHANGELOG_DIR });
}

async function main(): Promise<void> {
  console.log("📋 Changelog inteligente — inicio");

  await syncRepos();

  const entries = await getRecentChanges();
  console.log(`📝 ${entries.length} cambios en los últimos 7 días`);

  if (entries.length === 0) {
    console.log("✅ Sin cambios esta semana");
    return;
  }

  const releaseNotes = generateReleaseNotes(entries);
  await publishReleaseNotes(releaseNotes);

  // Notificar por email
  const authors = [...new Set(entries.map((e) => e.author))].join(", ");
  const feats = entries.filter((e) => e.type === "FEAT").length;
  const fixes = entries.filter((e) => e.type === "FIX").length;

  await notifyRejectionEmail("RELEASE-NOTES",
    `📋 Release Notes publicadas (semana ${new Date().toISOString().slice(0, 10)})\n\n` +
    `${entries.length} cambios | ${feats} features | ${fixes} fixes\n` +
    `Contribuidores: ${authors}\n\n` +
    `Ver: https://github.com/Narobial/narobial-changelog/blob/main/RELEASE-NOTES.md`
  );

  console.log("🏁 Release notes publicadas y notificadas");
}

main().catch((err) => {
  console.error("❌ Error en changelog-generator:", err);
  process.exit(1);
});
