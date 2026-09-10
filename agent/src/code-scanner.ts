/**
 * Orquestación de /generar (alias /q700, /scan).
 *
 * Prepara un workspace del frontend en la rama `hotfix-master` y lanza
 * kiro-cli (con fallback a codex) durante una ventana acotada (~10 min) para
 * que localice code smells / incidencias de calidad de Angular en el proyecto.
 *
 * El agente NO arregla nada: solo detecta y describe. Deja cada hallazgo como
 * una línea JSON en `FINDINGS.jsonl`. Después, este módulo crea una issue de
 * GitHub por cada hallazgo (con dedupe) en el repositorio configurado.
 *
 * Reglas estrictas del agente durante el escaneo:
 *  - NUNCA commitea ni pushea.
 *  - NUNCA cambia de rama.
 *  - Solo lectura del código: no modifica ficheros del proyecto (solo escribe
 *    el fichero de salida FINDINGS.jsonl en la raíz).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { AGENT_ENV, runAgentWithFallback } from "./agent-executor.js";
import { config } from "./config.js";

const exec = promisify(execFile);

const FRONTEND_REPO_URL =
  config.repos.find((url) => url.includes("Narobial-Frontend"))
  ?? "https://github.com/Narobial/Narobial-Frontend";

/** Rama que se analiza: siempre hotfix-master, según lo pedido. */
const SCAN_BRANCH = "hotfix-master";
/** Fichero de salida donde el agente escribe un hallazgo por línea (JSONL). */
const FINDINGS_FILE = "FINDINGS.jsonl";
/** Ventana de escaneo por defecto (~10 min). */
const DEFAULT_SCAN_BUDGET_MS = 10 * 60 * 1000;
/** Límite de issues creadas por ejecución (protección anti-ruido). */
const MAX_ISSUES_PER_RUN = Number(process.env.SCAN_MAX_ISSUES_PER_RUN ?? "40");

/** Categorías de code smell que buscamos (guían al agente y clasifican issues). */
export const SMELL_CATEGORIES = [
  "json-parse-sin-try-catch",
  "variables-sin-tipar",
  "falta-optional-chaining",
  "subscripciones-observables-no-liberadas",
  "errores-http-no-controlados",
  "subscripciones-anidadas",
  "change-detection-onpush-mutacion",
  "mutacion-directa-arrays-objetos-compartidos",
  "ngfor-sin-trackby",
  "funciones-pesadas-en-template",
  "lifecycle-hooks-incorrectos",
  "dependencias-circulares",
  "routing-params-sin-cancelar-peticiones",
  "formularios-reactivos-form-get-bang",
  "abuso-patchvalue",
  "nombres-inconsistentes-html-ts",
  "guards-interceptors-mal-usados",
  "otros",
] as const;

export type SmellCategory = (typeof SMELL_CATEGORIES)[number];

/** Severidades admitidas por hallazgo. */
const SEVERITIES = ["alta", "media", "baja"] as const;
type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  /** Categoría del code smell (una de SMELL_CATEGORIES). */
  category: string;
  /** Título corto y accionable del hallazgo. */
  title: string;
  /** Ruta del fichero afectado, relativa a la raíz del repo. */
  file: string;
  /** Línea aproximada (opcional). */
  line?: number;
  /** Severidad estimada. */
  severity?: string;
  /** Explicación del problema. */
  problem: string;
  /** Fragmento de código problemático (opcional). */
  snippet?: string;
  /** Cómo resolverlo. */
  fix: string;
}

export interface ScanResult {
  ok: boolean;
  solver?: string;
  branch: string;
  /** Nº de hallazgos válidos parseados de FINDINGS.jsonl. */
  findingsCount: number;
  /** Issues creadas en esta ejecución. */
  createdIssues: Array<{ url: string; title: string; category: string }>;
  /** Hallazgos duplicados de una issue ya existente (no se recrean). */
  skippedDuplicates: number;
  /** Hallazgos descartados por no parsear o faltar campos. */
  invalidFindings: number;
  error?: string;
}

type StatusFn = (phase: string) => void;

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await exec("git", args, {
      cwd,
      env: AGENT_ENV,
      maxBuffer: 1024 * 1024 * 10,
    });
    return (stdout || stderr || "").trim();
  } catch (err) {
    return `(git ${args[0]} no disponible: ${(err as Error).message})`;
  }
}

/** Workspace dedicado al escaneo (aislado del de /chat). */
function scanWorkspaceDir(): string {
  return resolve(config.agentWorkspacesDir, "scan-workspace");
}

async function ensureWorkspace(): Promise<string> {
  const dir = scanWorkspaceDir();
  if (existsSync(resolve(dir, ".git"))) return dir;
  mkdirSync(resolve(config.agentWorkspacesDir), { recursive: true });
  await exec("git", ["clone", FRONTEND_REPO_URL, dir], {
    env: AGENT_ENV,
    maxBuffer: 1024 * 1024 * 20,
    timeout: 300_000,
  });
  return dir;
}

/** Deja el workspace limpio y posicionado en hotfix-master actualizado. */
async function prepareBranch(dir: string): Promise<void> {
  await git(dir, "fetch", "origin", "--prune");
  await git(dir, "reset", "--hard");
  await git(dir, "clean", "-fd");
  const co = await exec("git", ["-C", dir, "checkout", SCAN_BRANCH], { env: AGENT_ENV })
    .then(() => true)
    .catch(() => false);
  if (!co) {
    await exec("git", ["-C", dir, "checkout", "-b", SCAN_BRANCH, `origin/${SCAN_BRANCH}`], { env: AGENT_ENV });
  }
  await git(dir, "reset", "--hard", `origin/${SCAN_BRANCH}`);
}

function buildScanPrompt(budgetMinutes: number): string {
  const categories = SMELL_CATEGORIES.filter((c) => c !== "otros").join(", ");
  return `# Auditoría de calidad de código — Narobial-Frontend (rama ${SCAN_BRANCH})

Estás en el repositorio Narobial-Frontend, rama \`${SCAN_BRANCH}\`. Actúa como
auditor de calidad de Angular 19. Tu única tarea es DETECTAR incidencias de
código (code smells, malas prácticas, riesgos). NO las arregles.

## Ventana de trabajo

Dispones de aproximadamente ${budgetMinutes} minutos. Recorre el código de
\`src/app/\` de forma sistemática (empieza por servicios, componentes con
suscripciones, formularios reactivos, guards e interceptors) y registra tantos
hallazgos REALES y concretos como encuentres en ese tiempo. Prioriza calidad
sobre cantidad: cada hallazgo debe apuntar a un fichero y una causa reales.

## Qué buscar (no exhaustivo)

Busca al menos estos patrones y cualquier otro problema de calidad que detectes:

- \`JSON.parse\` (o \`JSON.stringify\` sobre datos externos) sin \`try/catch\`.
- Variables, parámetros o retornos sin tipar, o uso de \`any\`.
- Sitios donde falta optional chaining (\`?.\`) o nullish coalescing (\`??\`) y hay
  comprobaciones manuales de null/undefined o accesos que pueden romper.
- Suscripciones a Observables que no se liberan (sin \`takeUntilDestroyed\`,
  \`| async\`, \`toSignal\` ni unsubscribe en \`ngOnDestroy\`).
- Errores HTTP no controlados (observables con I/O sin \`catchError\`).
- Suscripciones anidadas (subscribe dentro de subscribe) que deberían usar
  \`switchMap\`/\`mergeMap\`/\`forkJoin\`.
- Problemas de Change Detection: mezcla de \`OnPush\`, mutación de objetos y
  código asíncrono.
- Mutación directa de arrays u objetos compartidos.
- \`*ngFor\` o \`@for\` sin \`trackBy\`/\`track\`, especialmente en listas grandes.
- Llamadas a funciones pesadas en el HTML (p.ej. \`{{ calcularPrecioTotal() }}\`).
- Uso incorrecto de lifecycle hooks.
- Dependencias circulares.
- Routing y manejo de parámetros sin cancelar peticiones anteriores.
- Formularios reactivos frágiles: \`form.get('campo')!.value\`, nombres
  inconsistentes entre HTML y TypeScript, abuso de \`patchValue(...)\`.
- Guards e interceptors mal usados o mal registrados.
- Categorías sugeridas para clasificar: ${categories}.

## Entrega (MUY IMPORTANTE — formato estricto)

Escribe los hallazgos en el fichero \`${FINDINGS_FILE}\` en la RAÍZ del repo,
en formato JSON Lines: **un objeto JSON por línea**, sin comas entre líneas, sin
envolverlo en un array, sin markdown, sin texto adicional.

Cada línea debe ser un objeto con exactamente estas claves:

\`\`\`
{"category":"<una-categoria>","title":"<titulo corto accionable>","file":"src/app/...","line":<numero opcional>,"severity":"alta|media|baja","problem":"<que esta mal y por que>","snippet":"<fragmento breve, opcional>","fix":"<como resolverlo, concreto>"}
\`\`\`

Reglas del fichero de salida:
- Cada hallazgo en su propia línea, JSON válido e independiente.
- \`file\` es obligatorio y debe ser una ruta real relativa a la raíz del repo.
- \`category\` debe ser una de las categorías sugeridas o "otros".
- No inventes hallazgos: si no estás seguro de que el fichero/patrón existe, no
  lo incluyas.
- No repitas el mismo hallazgo (misma categoría + mismo fichero + misma causa).

## Reglas ESTRICTAS

1. NO hagas \`git commit\` ni \`git push\`.
2. NO cambies de rama.
3. NO modifiques ficheros del proyecto. Lo único que escribes es
   \`${FINDINGS_FILE}\`.
4. No ejecutes builds ni tests: es una auditoría de lectura.`;
}

/** Valida y normaliza un objeto parseado a Finding, o devuelve null si es inválido. */
function toFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const file = typeof obj.file === "string" ? obj.file.trim() : "";
  const problem = typeof obj.problem === "string" ? obj.problem.trim() : "";
  const fix = typeof obj.fix === "string" ? obj.fix.trim() : "";
  const titleRaw = typeof obj.title === "string" ? obj.title.trim() : "";

  // file + al menos una descripción son obligatorios.
  if (!file || (!problem && !titleRaw)) return null;

  const category = typeof obj.category === "string" && obj.category.trim()
    ? obj.category.trim()
    : "otros";

  const severity: Severity | undefined =
    typeof obj.severity === "string" && (SEVERITIES as readonly string[]).includes(obj.severity)
      ? (obj.severity as Severity)
      : undefined;

  const lineNum = typeof obj.line === "number" && Number.isFinite(obj.line)
    ? Math.trunc(obj.line)
    : undefined;

  const snippet = typeof obj.snippet === "string" && obj.snippet.trim()
    ? obj.snippet.trim()
    : undefined;

  return {
    category,
    title: titleRaw || `${category} en ${file}`,
    file,
    line: lineNum,
    severity,
    problem: problem || titleRaw,
    snippet,
    fix: fix || "Revisar el patrón indicado y aplicar la corrección adecuada según las convenciones de AGENTS.md.",
  };
}

/** Parsea FINDINGS.jsonl de forma tolerante (ignora líneas no-JSON). */
async function parseFindings(dir: string): Promise<{ findings: Finding[]; invalid: number }> {
  let content: string;
  try {
    content = await readFile(join(dir, FINDINGS_FILE), "utf8");
  } catch {
    return { findings: [], invalid: 0 };
  }

  const findings: Finding[] = [];
  let invalid = 0;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    // Ignorar posibles delimitadores de array si el agente los añadió.
    if (line === "[" || line === "]" || line === ",") continue;
    const clean = line.replace(/,\s*$/, "");

    try {
      const parsed = JSON.parse(clean);
      const finding = toFinding(parsed);
      if (finding) findings.push(finding);
      else invalid++;
    } catch {
      invalid++;
    }
  }

  return { findings, invalid };
}

/** Clave de deduplicación estable de un hallazgo. */
function dedupeKey(f: Finding): string {
  return `${f.category}::${f.file.toLowerCase()}::${f.title.toLowerCase()}`;
}

/** Marcador oculto que embebemos en el body para deduplicar contra GitHub. */
function fingerprintMarker(f: Finding): string {
  return `<!-- scan-fingerprint: ${dedupeKey(f)} -->`;
}

function buildIssueTitle(f: Finding): string {
  const sev = f.severity ? `[${f.severity}] ` : "";
  const base = `${sev}${f.title}`;
  // GitHub recomienda títulos cortos.
  return base.length > 120 ? `${base.slice(0, 117)}...` : base;
}

function buildIssueBody(f: Finding): string {
  const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
  const snippetBlock = f.snippet
    ? `\n### Código detectado\n\n\`\`\`ts\n${f.snippet}\n\`\`\`\n`
    : "";
  return `## Hallazgo de auditoría de calidad (automático)

Detectado por el escaneo automático de code smells sobre la rama \`${SCAN_BRANCH}\`.

- **Categoría:** \`${f.category}\`
- **Severidad:** ${f.severity ?? "no estimada"}
- **Ubicación:** ${loc}

### Problema

${f.problem}
${snippetBlock}
### Solución propuesta

${f.fix}

### Criterios de aceptación

- [ ] Corregir el problema descrito en ${loc}.
- [ ] Respetar las convenciones de \`AGENTS.md\` (tipado estricto, sin \`any\`, RxJS con \`takeUntilDestroyed\`, \`@for\` con \`track\`, etc.).
- [ ] Añadir o actualizar el \`*.spec.ts\` relacionado.
- [ ] No introducir regresiones en la funcionalidad existente.

${fingerprintMarker(f)}`;
}

function buildLabels(f: Finding): string[] {
  const labels = ["code-smell", "ai-generated", "calidad"];
  const cat = f.category.slice(0, 45);
  labels.push(`smell:${cat}`);
  if (f.severity) labels.push(`severidad:${f.severity}`);
  return labels;
}

/** Crea las labels que no existan (best-effort, no bloquea si falla). */
async function ensureLabels(labels: string[]): Promise<string[]> {
  let existing = new Set<string>();
  try {
    const { stdout } = await exec("gh", [
      "label", "list",
      "-R", config.repo,
      "--json", "name",
      "--limit", "300",
    ]);
    existing = new Set((JSON.parse(stdout) as Array<{ name: string }>).map((l) => l.name));
  } catch {
    // Si no podemos listar labels, intentamos crear/usar igualmente.
  }

  const valid: string[] = [];
  for (const label of labels) {
    if (!existing.has(label)) {
      try {
        await exec("gh", ["label", "create", label, "-R", config.repo, "--color", "D93F0B"]);
      } catch {
        // Puede fallar si ya existe (carrera) o sin permisos: la usamos igualmente.
      }
    }
    valid.push(label);
  }
  return valid;
}

/** Busca una issue existente con el mismo fingerprint (dedupe contra GitHub). */
async function findExistingIssue(f: Finding): Promise<number | null> {
  const key = dedupeKey(f);
  try {
    const { stdout } = await exec("gh", [
      "issue", "list",
      "-R", config.repo,
      "--state", "all",
      "--search", `\"scan-fingerprint: ${key}\" in:body`,
      "--json", "number,body",
      "--limit", "10",
    ]);
    const issues = JSON.parse(stdout) as Array<{ number: number; body: string }>;
    const marker = fingerprintMarker(f);
    const match = issues.find((i) => (i.body ?? "").includes(marker));
    return match?.number ?? null;
  } catch {
    return null;
  }
}

function writeTmpBody(content: string): string {
  const path = join(tmpdir(), `scan-issue-${randomUUID()}.md`);
  writeFileSync(path, content);
  return path;
}

/** Crea una issue en GitHub para un hallazgo, con dedupe. Devuelve la URL o null. */
async function createIssueForFinding(f: Finding): Promise<{ url: string; duplicate: boolean } | null> {
  const existing = await findExistingIssue(f);
  if (existing) {
    return { url: `https://github.com/${config.repo}/issues/${existing}`, duplicate: true };
  }

  const title = buildIssueTitle(f);
  const body = buildIssueBody(f);
  const labels = await ensureLabels(buildLabels(f));
  const bodyFile = writeTmpBody(body);

  try {
    const args = [
      "issue", "create",
      "-R", config.repo,
      "--title", title,
      "--body-file", bodyFile,
    ];
    for (const l of labels) args.push("--label", l);

    const { stdout } = await exec("gh", args, {
      env: { ...AGENT_ENV, GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN },
    });
    return { url: stdout.trim(), duplicate: false };
  } catch (err) {
    // Reintento sin labels por si alguna label no es válida en el repo.
    try {
      const { stdout } = await exec("gh", [
        "issue", "create",
        "-R", config.repo,
        "--title", title,
        "--body-file", bodyFile,
      ], { env: { ...AGENT_ENV, GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN } });
      return { url: stdout.trim(), duplicate: false };
    } catch (err2) {
      console.error(`No se pudo crear issue para ${f.file}: ${(err2 as Error).message}`);
      return null;
    }
  } finally {
    unlink(bodyFile).catch(() => {});
  }
}

/**
 * Ejecuta el escaneo completo:
 *  1. Prepara workspace en hotfix-master.
 *  2. Lanza kiro-cli (fallback codex) durante ~budget para generar FINDINGS.jsonl.
 *  3. Parsea los hallazgos y crea una issue por hallazgo (con dedupe).
 */
export async function runCodeScan(
  onStatus: StatusFn,
  opts: { budgetMs?: number } = {},
): Promise<ScanResult> {
  const budgetMs = opts.budgetMs ?? DEFAULT_SCAN_BUDGET_MS;
  const budgetMinutes = Math.max(1, Math.round(budgetMs / 60_000));

  const result: ScanResult = {
    ok: false,
    branch: SCAN_BRANCH,
    findingsCount: 0,
    createdIssues: [],
    skippedDuplicates: 0,
    invalidFindings: 0,
  };

  onStatus("preparando workspace en hotfix-master");
  const dir = await ensureWorkspace();
  await prepareBranch(dir);

  // Limpiar cualquier FINDINGS.jsonl de una ejecución previa.
  await unlink(join(dir, FINDINGS_FILE)).catch(() => {});

  onStatus(`escaneando código (~${budgetMinutes} min)`);
  const prompt = buildScanPrompt(budgetMinutes);

  try {
    // Acotamos el tiempo del agente a la ventana de escaneo (el executor tiene
    // su propio límite máximo; aquí forzamos el presupuesto pedido).
    const previousLimit = process.env.AGENT_MAX_RUNTIME_MS;
    process.env.AGENT_MAX_RUNTIME_MS = String(budgetMs);
    try {
      const execRes = await runAgentWithFallback(prompt, dir);
      result.solver = execRes.solver;
    } finally {
      if (previousLimit === undefined) delete process.env.AGENT_MAX_RUNTIME_MS;
      else process.env.AGENT_MAX_RUNTIME_MS = previousLimit;
    }
  } catch (err) {
    result.error = (err as Error).message;
    // Aun con error/timeout intentamos aprovechar los hallazgos ya escritos.
  }

  onStatus("procesando hallazgos");
  const { findings, invalid } = await parseFindings(dir);
  result.invalidFindings = invalid;

  // Dedupe local antes de tocar GitHub.
  const seen = new Set<string>();
  const unique: Finding[] = [];
  for (const f of findings) {
    const key = dedupeKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }
  result.findingsCount = unique.length;

  const toCreate = unique.slice(0, MAX_ISSUES_PER_RUN);
  onStatus(`creando issues (${toCreate.length} hallazgos)`);

  for (let i = 0; i < toCreate.length; i++) {
    const f = toCreate[i];
    onStatus(`creando issue ${i + 1}/${toCreate.length}`);
    const created = await createIssueForFinding(f);
    if (!created) continue;
    if (created.duplicate) {
      result.skippedDuplicates++;
    } else {
      result.createdIssues.push({ url: created.url, title: buildIssueTitle(f), category: f.category });
    }
  }

  // El fichero de hallazgos no se commitea; se limpia del workspace.
  await unlink(join(dir, FINDINGS_FILE)).catch(() => {});

  result.ok = !result.error || result.createdIssues.length > 0 || result.skippedDuplicates > 0;
  return result;
}
