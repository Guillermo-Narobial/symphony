import "dotenv/config";
import nodemailer from "nodemailer";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);

const FRONTEND_DIR = resolve(process.env.GLOSSARY_FRONTEND_REPO_DIR ?? config.frontendRepoDir);
const TARGET_BRANCH = process.env.GLOSSARY_TARGET_BRANCH ?? "hotfix-master";
const GLOSSARY_FILE = process.env.GLOSSARY_MARKDOWN_PATH ?? "docs/translation-glossary.md";
const DMS_SERVER = process.env.GLOSSARY_DMS_SERVER ?? "master70";
const DMS_SERVER_CODE = process.env.GLOSSARY_DMS_SERVER_CODE ?? config.dmsServerCode;
const DMS_ENTITY = "GLOSARIO";
const DMS_METHOD = "GET.GLOSARIO";
const DMS_CUSTOM_INTERFACE = JSON.stringify({
  interfaces: ["id", "description", "translations.language", "translations.text"],
});

const PRIMARY_RECIPIENTS = [
  "guillermo.calleja@narobial.net",
  "jaime.garcia@narobial.net",
];

const FALLBACK_RECIPIENTS = [
  "guillermo.calleja@quiter.com",
  "jaime.garcia@quiter.com",
];

interface RawTranslation {
  language?: unknown;
  text?: unknown;
}

interface RawGlossaryItem {
  id?: unknown;
  description?: unknown;
  translations?: RawTranslation[] | Record<string, unknown>;
  [key: string]: unknown;
}

interface GlossaryTranslation {
  id: string;
  description: string;
  language: string;
  text: string;
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd: FRONTEND_DIR,
    env: process.env,
    maxBuffer: 1024 * 1024 * 20,
    timeout: 300_000,
  });
  return stdout.trim();
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

function dmsHeaders(): string {
  const parsed = JSON.parse(config.dmsHeaders) as { headers?: Record<string, unknown> };
  return JSON.stringify({
    ...parsed,
    headers: {
      ...(parsed.headers ?? {}),
      server: DMS_SERVER,
    },
  });
}

async function fetchGlossary(): Promise<GlossaryTranslation[]> {
  const res = await fetch(config.dmsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "*/*",
      "access-token": requiredEnv("DMS_ACCESS_TOKEN"),
      ClientId: requiredEnv("DMS_CLIENT_ID"),
      metododms: DMS_METHOD,
      entidadDms: DMS_ENTITY,
      methodtype: "GET",
      servercode: DMS_SERVER_CODE,
      headers: dmsHeaders(),
      custominterface: DMS_CUSTOM_INTERFACE,
    },
    body: JSON.stringify({
      queryParams: {},
      queryParamsData: [],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DMS glossary error: ${res.status} ${res.statusText} ${body.slice(0, 500)}`);
  }

  const data = await res.json() as {
    error?: string;
    message?: string;
    code?: string;
    procedures?: RawGlossaryItem[];
    data?: RawGlossaryItem[];
    glossary?: RawGlossaryItem[];
  };
  if (data.error || data.message || data.code) {
    throw new Error(`DMS glossary error: ${data.code ?? "UNKNOWN"} ${data.error ?? ""} ${data.message ?? ""}`.trim());
  }

  const rows = Array.isArray(data.glossary)
    ? data.glossary
    : Array.isArray(data.procedures)
      ? data.procedures
      : Array.isArray(data.data)
        ? data.data
        : [];
  const normalized = normalizeGlossary(rows);
  if (normalized.length === 0) throw new Error("DMS glossary response did not contain translations");
  return normalized;
}

function normalizeGlossary(rows: RawGlossaryItem[]): GlossaryTranslation[] {
  const result: GlossaryTranslation[] = [];

  for (const row of rows) {
    const id = toText(row.id);
    const description = toText(row.description);
    const nestedTranslations = normalizeNestedTranslations(row.translations);
    const flatLanguage = toText(row["translations.language"]);
    const flatText = toText(row["translations.text"]);

    for (const translation of nestedTranslations) {
      if (!description || !translation.language || !translation.text) continue;
      result.push({ id, description, language: translation.language, text: translation.text });
    }

    if (description && flatLanguage && flatText) {
      result.push({ id, description, language: flatLanguage, text: flatText });
    }
  }

  return dedupe(result).sort((a, b) =>
    a.description.localeCompare(b.description, "es")
    || a.language.localeCompare(b.language, "es")
    || a.id.localeCompare(b.id, "es")
  );
}

function normalizeNestedTranslations(value: RawGlossaryItem["translations"]): Array<{ language: string; text: string }> {
  if (Array.isArray(value)) {
    return value
      .map((item) => ({ language: toText(item.language), text: toText(item.text) }))
      .filter((item) => item.language && item.text);
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([language, text]) => ({ language: toText(language), text: toText(text) }))
      .filter((item) => item.language && item.text);
  }

  return [];
}

function dedupe(items: GlossaryTranslation[]): GlossaryTranslation[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.id}|${item.description}|${item.language}|${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function renderMarkdown(items: GlossaryTranslation[]): string {
  const generatedAt = new Date().toISOString();
  const rows = items.map((item) =>
    `| ${escapeMarkdownCell(item.id)} | ${escapeMarkdownCell(item.description)} | ${escapeMarkdownCell(item.language)} | ${escapeMarkdownCell(item.text)} |`
  );

  return `---
name: translation-glossary
description: Glosario oficial DMS para traducciones de Narobial. Consultar siempre antes de crear o modificar textos i18n.
---

# Glosario oficial de traducciones

> Archivo generado automaticamente desde DMS. No editar a mano.

- Origen DMS: servidor \`${DMS_SERVER}\`, servercode \`${DMS_SERVER_CODE}\`, entidad \`${DMS_ENTITY}\`, metodo \`${DMS_METHOD}\`
- Custom interface: \`id\`, \`description\`, \`translations.language\`, \`translations.text\`
- Ultima sincronizacion: \`${generatedAt}\`

## Uso obligatorio para agentes

1. Antes de crear o modificar cualquier traduccion, buscar primero en este glosario.
2. Si el termino exacto o una expresion equivalente ya existe, usar la traduccion aprobada del glosario.
3. Si hay coincidencias parciales, priorizar la expresion mas larga y especifica. Ejemplo: si existe "orden de reparacion", no traducir sus palabras por separado.
4. Si el termino no existe, crear la traduccion siguiendo las reglas i18n del proyecto y mantener coherencia con los terminos cercanos del glosario.
5. No sobrescribir una traduccion del glosario con una alternativa libre salvo que el DMS actualice este archivo.

## Entradas

| ID | Termino base | Idioma | Traduccion aprobada |
| --- | --- | --- | --- |
${rows.join("\n")}
`;
}

async function ensureCleanWorkingTree(): Promise<void> {
  const status = await git("status", "--porcelain");
  if (status) {
    throw new Error(`Frontend repo has local changes; aborting glossary sync:\n${status}`);
  }
}

async function syncFrontendBranch(): Promise<void> {
  await ensureCleanWorkingTree();
  await git("fetch", "origin", "--prune");
  await git("switch", TARGET_BRANCH);
  await git("pull", "origin", TARGET_BRANCH, "--ff-only");
  await ensureCleanWorkingTree();
}

async function commitAndPushIfChanged(content: string): Promise<void> {
  const absoluteGlossaryPath = resolve(FRONTEND_DIR, GLOSSARY_FILE);
  await mkdir(dirname(absoluteGlossaryPath), { recursive: true });
  await writeFile(absoluteGlossaryPath, content, "utf-8");

  try {
    await git("diff", "--quiet", "--", GLOSSARY_FILE);
    console.log("Glosario sin cambios; no se crea commit.");
    return;
  } catch {
    await git("add", GLOSSARY_FILE);
    await git("commit", "-m", "docs(i18n): Actualiza glosario DMS");
    await git("push", "origin", TARGET_BRANCH);
  }
}

async function notifyFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const subject = `[Symphony] Error sincronizando glosario DMS`;
  const html = `<h2>Error sincronizando glosario DMS</h2>
<p><strong>Repo:</strong> ${FRONTEND_DIR}</p>
<p><strong>Rama:</strong> ${TARGET_BRANCH}</p>
<p><strong>Archivo:</strong> ${GLOSSARY_FILE}</p>
<pre>${escapeHtml(message)}</pre>`;

  const transporter = nodemailer.createTransport({
    host: "smtp-relay.gmail.com",
    port: 465,
    secure: true,
  });

  try {
    await transporter.sendMail({
      from: "noreply@narobial.net",
      to: PRIMARY_RECIPIENTS.join(", "),
      subject,
      html,
    });
  } catch {
    await transporter.sendMail({
      from: "noreply@narobial.net",
      to: FALLBACK_RECIPIENTS.join(", "),
      subject,
      html,
    });
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function main(): Promise<void> {
  console.log("Glossary sync: inicio");
  await syncFrontendBranch();
  const glossary = await fetchGlossary();
  console.log(`Glossary sync: recibidas ${glossary.length} traducciones`);
  await commitAndPushIfChanged(renderMarkdown(glossary));
  console.log("Glossary sync: fin");
}

main().catch(async (error) => {
  console.error("Glossary sync failed:", error);
  try {
    await notifyFailure(error);
  } catch (notifyError) {
    console.error("Glossary failure notification also failed:", notifyError);
  }
  process.exit(1);
});
