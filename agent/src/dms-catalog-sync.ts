import "dotenv/config";
import nodemailer from "nodemailer";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const FRONTEND_DIR = resolve(process.env.DMS_CATALOG_FRONTEND_REPO_DIR ?? process.env.FRONTEND_REPO_DIR ?? "/home/gcalleja/code/Narobial-Frontend");
const TARGET_BRANCH = process.env.DMS_CATALOG_TARGET_BRANCH ?? "release";
const CATALOG_FILE = process.env.DMS_CATALOG_MARKDOWN_PATH ?? "docs/dms-catalog.md";
const SOURCE_DIR = process.env.DMS_CATALOG_SOURCE_DIR ?? "src/app";
const AUTO_RESET_SYNC_WORKTREE = process.env.DMS_CATALOG_AUTO_RESET_SYNC_WORKTREE !== "false";
const SYNC_WORKTREE_SUFFIX = "-release-sync";

const PRIMARY_RECIPIENTS = [
  "guillermo.calleja@narobial.net",
  "jaime.garcia@narobial.net",
];

const FALLBACK_RECIPIENTS = [
  "guillermo.calleja@quiter.com",
  "jaime.garcia@quiter.com",
];

type CatalogEntry = {
  entity: string;
  method: string;
  fields: string[];
  usedIn: string[];
};

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd: FRONTEND_DIR,
    env: process.env,
    maxBuffer: 1024 * 1024 * 20,
    timeout: 300_000,
  });
  return stdout.trim();
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listFilesRecursive(absolutePath));
      continue;
    }
    if (entry.isFile()) {
      results.push(absolutePath);
    }
  }

  return results;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function extractFieldsFromArrayLiteral(arrayLiteral: string): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  const stringLiteralRegex = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

  for (const match of arrayLiteral.matchAll(stringLiteralRegex)) {
    const rawValue = match[2]
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\`/g, "`")
      .replace(/\\\\/g, "\\");
    if (!rawValue || rawValue.includes("${") || seen.has(rawValue)) {
      continue;
    }
    seen.add(rawValue);
    fields.push(rawValue);
  }

  return fields;
}

function extractNamedArrayResolvers(content: string): Map<string, string[]> {
  const resolvers = new Map<string, string[]>();
  const patterns = [
    /(?:public|private|protected)?\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*(?::[^=;\n]+)?=\s*(\[[\s\S]{0,5000}?\]);/g,
    /(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(\[[\s\S]{0,5000}?\]);/g,
    /(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::[^{\n]+)?\{[\s\S]{0,5000}?return\s*(\[[\s\S]{0,5000}?\]);/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const name = match[1];
      const fields = extractFieldsFromArrayLiteral(match[2]);
      if (name && fields.length > 0 && !resolvers.has(name)) {
        resolvers.set(name, fields);
      }
    }
  }

  return resolvers;
}

function resolveInterfaceFields(snippet: string, resolvers: Map<string, string[]>): string[] {
  const directArrayMatch = snippet.match(/\.setInterface\(\s*(\[[\s\S]*?\])\s*\)/);
  if (directArrayMatch) {
    return extractFieldsFromArrayLiteral(directArrayMatch[1]);
  }

  const resolverPatterns = [
    /\.setInterface\(\s*this\.([A-Za-z_]\w*)\(\)\s*\)/,
    /\.setInterface\(\s*([A-Za-z_]\w*)\(\)\s*\)/,
    /\.setInterface\(\s*this\.([A-Za-z_]\w*)\s*\)/,
    /\.setInterface\(\s*([A-Za-z_]\w*)\s*\)/,
  ];

  for (const pattern of resolverPatterns) {
    const match = snippet.match(pattern);
    const fields = match ? resolvers.get(match[1]) : undefined;
    if (fields && fields.length > 0) {
      return fields;
    }
  }

  return [];
}

function extractBuilderSnippets(content: string): string[] {
  const snippets: string[] = [];
  let cursor = 0;

  while (true) {
    const builderIndex = content.indexOf("dmsApiBuilder", cursor);
    if (builderIndex === -1) {
      break;
    }

    const buildIndex = content.indexOf(".build(", builderIndex);
    if (buildIndex === -1 || buildIndex - builderIndex > 200) {
      cursor = builderIndex + "dmsApiBuilder".length;
      continue;
    }

    const requestIndex = content.indexOf(".request(", buildIndex);
    if (requestIndex === -1) {
      cursor = buildIndex + ".build(".length;
      continue;
    }

    const snippet = content.slice(builderIndex, requestIndex + ".request(".length);
    if (snippet.length <= 12_000) {
      snippets.push(snippet);
    }

    cursor = requestIndex + ".request(".length;
  }

  return snippets;
}

function upsertEntry(entries: Map<string, CatalogEntry>, entity: string, method: string, fields: string[], usedIn: string): void {
  const key = `${entity}\u0000${method}`;
  const current = entries.get(key) ?? { entity, method, fields: [], usedIn: [] };

  for (const field of fields) {
    if (field && !current.fields.includes(field)) {
      current.fields.push(field);
    }
  }

  if (!current.usedIn.includes(usedIn)) {
    current.usedIn.push(usedIn);
  }

  entries.set(key, current);
}

function parseExistingCatalog(content: string): Map<string, string[]> {
  const fieldsByKey = new Map<string, string[]>();
  let currentEntity = "";
  let currentMethod = "";

  for (const rawLine of normalizeLineEndings(content).split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      currentEntity = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("### ")) {
      currentMethod = line.slice(4).trim();
      continue;
    }
    if (!line.startsWith("Campos:") || !currentEntity || !currentMethod) {
      continue;
    }

    const fields: string[] = [];
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      fields.push(match[1]);
    }
    fieldsByKey.set(`${currentEntity}\u0000${currentMethod}`, fields);
  }

  return fieldsByKey;
}

async function generateCatalogEntries(): Promise<CatalogEntry[]> {
  const sourceRoot = resolve(FRONTEND_DIR, SOURCE_DIR);
  const catalogPath = resolve(FRONTEND_DIR, CATALOG_FILE);
  const existingCatalog = parseExistingCatalog(await readFile(catalogPath, "utf-8"));
  const files = (await listFilesRecursive(sourceRoot))
    .filter((filePath) => filePath.endsWith(".ts") && !filePath.endsWith(".spec.ts"))
    .sort((left, right) => left.localeCompare(right, "es"));

  const entries = new Map<string, CatalogEntry>();

  for (const filePath of files) {
    const source = normalizeLineEndings(await readFile(filePath, "utf-8"));
    if (!source.includes("dmsApiBuilder")) {
      continue;
    }

    const resolvers = extractNamedArrayResolvers(source);
    const usedIn = relative(resolve(FRONTEND_DIR, SOURCE_DIR), filePath).replace(/\\/g, "/");

    for (const snippet of extractBuilderSnippets(source)) {
      const entityMatch = snippet.match(/\.setEntidad\(\s*(['"`])([^'"`]+)\1\s*\)/);
      const methodMatch = snippet.match(/\.setMetodo\(\s*(['"`])([^'"`]+)\1\s*\)/);
      const entity = entityMatch?.[2]?.trim();
      const method = methodMatch?.[2]?.trim();

      if (!entity || !method) {
        continue;
      }

      let fields = resolveInterfaceFields(snippet, resolvers);
      if (fields.length === 0) {
        fields = existingCatalog.get(`${entity}\u0000${method}`) ?? [];
      }

      upsertEntry(entries, entity, method, fields, usedIn);
    }
  }

  return [...entries.values()]
    .sort((left, right) =>
      left.entity.localeCompare(right.entity, "es")
      || left.method.localeCompare(right.method, "es")
    );
}

function summarizeUsedIn(paths: string[]): string {
  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right, "es"));
  const visible = sortedPaths.slice(0, 3);
  if (sortedPaths.length <= 3) {
    return visible.join(", ");
  }
  return `${visible.join(", ")} (+${sortedPaths.length - 3} mas)`;
}

function renderMarkdown(entries: CatalogEntry[]): string {
  const entities = new Map<string, CatalogEntry[]>();

  for (const entry of entries) {
    const current = entities.get(entry.entity) ?? [];
    current.push(entry);
    entities.set(entry.entity, current);
  }

  const sections: string[] = [];
  for (const [entity, methods] of entities) {
    sections.push(`## ${entity}`);
    sections.push("");

    for (const method of methods) {
      const fields = method.fields.length > 0
        ? method.fields.map((field) => `\`${field}\``).join(", ")
        : "_sin interfaz estatica resuelta_";
      sections.push(`### ${method.method}`);
      sections.push("");
      sections.push(`Campos: ${fields}`);
      sections.push("");
      sections.push(`Usado en: ${summarizeUsedIn(method.usedIn)}`);
      sections.push("");
    }

    sections.push("---");
    sections.push("");
  }

  return `---
name: dms-catalog
description: Catalogo DMS con ${entries.length} combinaciones entidad/metodo y sus campos (interfaces). Consultar SIEMPRE antes de crear o modificar llamadas al DMS.
---

# Catalogo DMS - Narobial

Total: **${entries.length} combinaciones** entidad/metodo en **${entities.size} entidades**

Generado automaticamente del codigo fuente del frontend.

Ultima sincronizacion automatica: \`${new Date().toISOString()}\`

---

${sections.join("\n").trimEnd()}
`;
}

async function ensureCleanWorkingTree(): Promise<void> {
  const status = await git("status", "--porcelain");
  if (status) {
    throw new Error(`Frontend repo has local changes; aborting DMS catalog sync:\n${status}`);
  }
}

async function resetSyncWorktreeIfNeeded(): Promise<void> {
  const status = await git("status", "--porcelain");
  if (!status) {
    return;
  }

  const isDedicatedSyncWorktree = FRONTEND_DIR.endsWith(SYNC_WORKTREE_SUFFIX);
  if (!AUTO_RESET_SYNC_WORKTREE || !isDedicatedSyncWorktree) {
    throw new Error("Frontend repo has local changes; aborting DMS catalog sync:\n" + status);
  }

  console.log("DMS catalog sync: limpiando cambios locales del worktree dedicado");
  await git("reset", "--hard", "HEAD");
  await git("clean", "-fd");
}

async function syncFrontendBranch(): Promise<void> {
  await git("switch", TARGET_BRANCH);
  await resetSyncWorktreeIfNeeded();
  await git("fetch", "origin", "--prune");
  await git("pull", "origin", TARGET_BRANCH, "--ff-only");
  await ensureCleanWorkingTree();
}

async function commitAndPushIfChanged(content: string): Promise<void> {
  const absoluteCatalogPath = resolve(FRONTEND_DIR, CATALOG_FILE);
  await mkdir(dirname(absoluteCatalogPath), { recursive: true });
  await writeFile(absoluteCatalogPath, content, "utf-8");

  try {
    await git("diff", "--quiet", "--", CATALOG_FILE);
    console.log("DMS catalog sin cambios; no se crea commit.");
    return;
  } catch {
    await git("add", CATALOG_FILE);
    await git("commit", "--no-verify", "-m", "docs(dms): Actualiza catalogo DMS");
    await git("push", "origin", TARGET_BRANCH);
  }
}

async function notifyFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const subject = "[Symphony] Error sincronizando catalogo DMS";
  const html = `<h2>Error sincronizando catalogo DMS</h2>
<p><strong>Repo:</strong> ${FRONTEND_DIR}</p>
<p><strong>Rama:</strong> ${TARGET_BRANCH}</p>
<p><strong>Archivo:</strong> ${CATALOG_FILE}</p>
<pre>${escapeHtml(message)}</pre>`;

  try {
    await sendMailWithRetry(PRIMARY_RECIPIENTS, subject, html);
  } catch {
    await sendMailWithRetry(FALLBACK_RECIPIENTS, subject, html);
  }
}

async function sendMailWithRetry(recipients: string[], subject: string, html: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const transporter = nodemailer.createTransport({
        host: "smtp-relay.gmail.com",
        port: 465,
        secure: true,
      });
      await transporter.sendMail({
        from: "noreply@narobial.net",
        to: recipients.join(", "),
        subject,
        html,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(5000 * attempt);
      }
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function ensureSourceDirectoryExists(): Promise<void> {
  const sourceRoot = resolve(FRONTEND_DIR, SOURCE_DIR);
  const sourceStat = await stat(sourceRoot).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new Error(`Source directory not found: ${sourceRoot}`);
  }
}

async function main(): Promise<void> {
  console.log("DMS catalog sync: inicio");
  await syncFrontendBranch();
  await ensureSourceDirectoryExists();
  const entries = await generateCatalogEntries();
  if (entries.length === 0) {
    throw new Error("No se detectaron llamadas dmsApiBuilder para generar el catalogo");
  }
  console.log(`DMS catalog sync: detectadas ${entries.length} combinaciones`);
  await commitAndPushIfChanged(renderMarkdown(entries));
  console.log("DMS catalog sync: fin");
}

main().catch(async (error) => {
  console.error("DMS catalog sync failed:", error);
  try {
    await notifyFailure(error);
  } catch (notifyError) {
    console.error("DMS catalog failure notification also failed:", notifyError);
  }
  process.exit(1);
});
