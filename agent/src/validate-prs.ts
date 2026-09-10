/**
 * Orquestación de /validarprs.
 *
 * Revisa con IA las Pull Requests abiertas cuya rama de origen empiece por
 * `hotfix/` y que vayan contra `hotfix-master`. Por cada PR:
 *
 *  1. Prepara un workspace del frontend con la rama de la PR + su diff contra base.
 *  2. Lanza kiro-cli (fallback codex) como revisor de calidad, centrado en
 *     PROBLEMAS GRAVES (bugs, seguridad, rompe build/tests, regresiones).
 *  3. El agente escribe un veredicto estructurado en REVIEW.json.
 *  4. Según el veredicto:
 *       - APPROVE  → `gh pr review --approve`
 *       - REJECT   → `gh pr review --request-changes` con los cambios solicitados
 *
 * NO mergea ni usa `--admin`: solo aprueba o solicita cambios al programador.
 *
 * Reglas estrictas del agente durante la revisión:
 *  - NUNCA commitea ni pushea.
 *  - NUNCA cambia de rama.
 *  - Solo lectura del código: lo único que escribe es REVIEW.json en la raíz.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
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

/** Rama base contra la que deben ir las PRs a validar. */
const BASE_BRANCH = "hotfix-master";
/** Prefijo obligatorio de la rama de origen de la PR. */
const HEAD_PREFIX = "hotfix/";
/** Fichero donde el agente escribe su veredicto (JSON). */
const REVIEW_FILE = "REVIEW.json";
/** Ventana de revisión por PR (~8 min). */
const DEFAULT_REVIEW_BUDGET_MS = 8 * 60 * 1000;

type Verdict = "approve" | "request-changes";

/** Info mínima de una PR candidata. */
export interface PrInfo {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  author: string;
}

/** Veredicto de la IA sobre una PR. */
export interface Review {
  verdict: Verdict;
  /** Resumen breve del razonamiento. */
  summary: string;
  /** Problemas graves detectados (vacío si aprueba). */
  issues: Array<{
    severity: "critica" | "alta";
    file?: string;
    line?: number;
    problem: string;
    fix: string;
  }>;
}

/** Resultado por PR ya procesada. */
export interface PrResult {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  applied: Verdict | "error";
  summary: string;
  issuesCount: number;
  solver?: string;
  error?: string;
}

export interface ValidateResult {
  ok: boolean;
  /** PRs candidatas encontradas (hotfix/* -> hotfix-master). */
  candidates: number;
  results: PrResult[];
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

/** Workspace dedicado a la validación (aislado de /scan y /chat). */
function validateWorkspaceDir(): string {
  return resolve(config.agentWorkspacesDir, "validate-workspace");
}

async function ensureWorkspace(): Promise<string> {
  const dir = validateWorkspaceDir();
  if (existsSync(resolve(dir, ".git"))) return dir;
  mkdirSync(resolve(config.agentWorkspacesDir), { recursive: true });
  await exec("git", ["clone", FRONTEND_REPO_URL, dir], {
    env: AGENT_ENV,
    maxBuffer: 1024 * 1024 * 20,
    timeout: 300_000,
  });
  return dir;
}

/**
 * Lista las PRs abiertas candidatas: rama de origen `hotfix/*` contra
 * `hotfix-master`. Si `only` se indica, filtra a esa única PR (y valida que
 * cumpla el criterio).
 */
async function listCandidatePrs(only?: number): Promise<PrInfo[]> {
  const { stdout } = await exec("gh", [
    "pr", "list",
    "-R", config.repo,
    "--state", "open",
    "--base", BASE_BRANCH,
    "--limit", "100",
    "--json", "number,title,headRefName,baseRefName,author",
  ], { env: { ...AGENT_ENV, GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN } });

  const raw = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    headRefName: string;
    baseRefName: string;
    author?: { login?: string };
  }>;

  let prs = raw
    .filter((p) => p.headRefName?.startsWith(HEAD_PREFIX) && p.baseRefName === BASE_BRANCH)
    .map((p) => ({
      number: p.number,
      title: p.title,
      headRefName: p.headRefName,
      baseRefName: p.baseRefName,
      author: p.author?.login ?? "desconocido",
    }));

  if (only !== undefined) {
    prs = prs.filter((p) => p.number === only);
  }

  return prs;
}

/** Deja el workspace en la rama de la PR, actualizada desde origin. */
async function checkoutPrBranch(dir: string, pr: PrInfo): Promise<void> {
  await git(dir, "fetch", "origin", "--prune");
  await git(dir, "reset", "--hard");
  await git(dir, "clean", "-fd");
  // Usamos `gh pr checkout` para traer la rama de la PR de forma fiable.
  await exec("gh", ["pr", "checkout", String(pr.number), "-R", config.repo], {
    cwd: dir,
    env: { ...AGENT_ENV, GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN },
    maxBuffer: 1024 * 1024 * 20,
  });
}

/** Diff de la PR contra la base, acotado para que quepa en el prompt. */
async function prDiff(dir: string): Promise<string> {
  const diff = await git(dir, "diff", `origin/${BASE_BRANCH}...HEAD`);
  const MAX = 60_000;
  if (diff.length <= MAX) return diff;
  return `${diff.slice(0, MAX)}\n\n[... diff truncado; revisa el código completo en el workspace ...]`;
}

function buildReviewPrompt(pr: PrInfo, diff: string, budgetMinutes: number): string {
  return `# Revisión de calidad de una Pull Request — Narobial-Frontend

Actúa como revisor senior de Angular 19 siguiendo las convenciones de \`AGENTS.md\`.
Estás en un workspace del repositorio, con la rama de la PR ya cargada.

## PR a revisar

- Número: #${pr.number}
- Título: ${pr.title}
- Rama origen: \`${pr.headRefName}\`
- Rama base: \`${pr.baseRefName}\`
- Autor: ${pr.author}

Dispones de aproximadamente ${budgetMinutes} minutos. Puedes leer el código del
workspace y el diff que se incluye más abajo.

## Criterio de decisión (IMPORTANTE)

Debes decidir entre APROBAR o SOLICITAR CAMBIOS. Solo solicita cambios por
PROBLEMAS GRAVES, es decir:

- Bugs funcionales o de lógica que rompan comportamiento.
- Fallos de seguridad (XSS, inyección, exposición de datos, tokens en cliente, etc.).
- Código que rompa el build o los tests, o que provoque regresiones claras.
- Errores que provoquen excepciones en runtime (accesos a null/undefined no
  controlados en rutas de ejecución reales, \`JSON.parse\` sin \`try/catch\` sobre
  datos externos, suscripciones que provoquen fugas de memoria evidentes, etc.).

NO solicites cambios por asuntos MENORES de estilo, nombres, formato, o
preferencias que no afecten a funcionamiento, seguridad ni estabilidad. Ante la
duda entre menor y grave, si no compromete funcionamiento/seguridad, APRUEBA.

## Entrega (formato estricto)

Escribe tu veredicto en el fichero \`${REVIEW_FILE}\` en la RAÍZ del repo, como un
ÚNICO objeto JSON válido (sin markdown, sin texto adicional), con esta forma:

\`\`\`json
{
  "verdict": "approve" | "request-changes",
  "summary": "<1-3 frases resumiendo la decisión>",
  "issues": [
    {
      "severity": "critica" | "alta",
      "file": "src/app/...",
      "line": 123,
      "problem": "<qué está mal y por qué es grave>",
      "fix": "<qué debe cambiar el programador, concreto>"
    }
  ]
}
\`\`\`

Reglas:
- Si \`verdict\` es \`approve\`, \`issues\` debe ser un array vacío \`[]\`.
- Si \`verdict\` es \`request-changes\`, incluye al menos un issue grave real.
- Cada issue debe apuntar a algo REAL del diff/código. No inventes problemas.

## Reglas ESTRICTAS de comportamiento

1. NO hagas \`git commit\` ni \`git push\`.
2. NO cambies de rama.
3. NO modifiques ficheros del proyecto. Lo único que escribes es \`${REVIEW_FILE}\`.
4. NO ejecutes builds ni tests que modifiquen el estado: es una revisión de lectura.

## Diff de la PR (contra \`${pr.baseRefName}\`)

\`\`\`diff
${diff}
\`\`\`
`;
}

/** Parsea REVIEW.json de forma tolerante. */
async function parseReview(dir: string): Promise<Review | null> {
  let content: string;
  try {
    content = await readFile(join(dir, REVIEW_FILE), "utf8");
  } catch {
    return null;
  }

  // El agente puede envolver el JSON en un bloque markdown; lo extraemos.
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : content).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  return toReview(parsed);
}

function toReview(raw: unknown): Review | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const verdict: Verdict =
    obj.verdict === "request-changes" ? "request-changes" : "approve";

  const summary = typeof obj.summary === "string" && obj.summary.trim()
    ? obj.summary.trim()
    : (verdict === "approve" ? "Sin problemas graves detectados." : "Requiere cambios.");

  const issuesRaw = Array.isArray(obj.issues) ? obj.issues : [];
  const issues: Review["issues"] = [];
  for (const it of issuesRaw) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const problem = typeof o.problem === "string" ? o.problem.trim() : "";
    if (!problem) continue;
    issues.push({
      severity: o.severity === "critica" ? "critica" : "alta",
      file: typeof o.file === "string" ? o.file.trim() || undefined : undefined,
      line: typeof o.line === "number" && Number.isFinite(o.line) ? Math.trunc(o.line) : undefined,
      problem,
      fix: typeof o.fix === "string" && o.fix.trim() ? o.fix.trim() : "Revisar y corregir el problema descrito.",
    });
  }

  // Coherencia: request-changes sin issues -> lo tratamos como approve seguro
  // no; mejor conservar el veredicto pero garantizar al menos un motivo genérico.
  if (verdict === "request-changes" && issues.length === 0) {
    issues.push({
      severity: "alta",
      problem: "La IA solicitó cambios pero no detalló issues concretos.",
      fix: "Revisar manualmente la PR antes de aprobar.",
    });
  }

  return { verdict, summary, issues };
}

/** Cuerpo del review de request-changes con los cambios solicitados. */
function buildRequestChangesBody(review: Review): string {
  const lines: string[] = [
    "## 🔴 Cambios solicitados (revisión automática por IA)",
    "",
    review.summary,
    "",
    "### Problemas graves a corregir",
    "",
  ];
  review.issues.forEach((iss, i) => {
    const loc = iss.file ? (iss.line ? ` \`${iss.file}:${iss.line}\`` : ` \`${iss.file}\``) : "";
    lines.push(`${i + 1}. **[${iss.severity}]**${loc} ${iss.problem}`);
    lines.push(`   - _Cómo resolverlo:_ ${iss.fix}`);
  });
  lines.push("");
  lines.push("_Corrige estos puntos y vuelve a solicitar revisión._");
  return lines.join("\n");
}

/** Aplica el veredicto en GitHub: approve o request-changes. */
async function applyVerdict(pr: PrInfo, review: Review): Promise<void> {
  const ghEnv = { ...AGENT_ENV, GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN };

  if (review.verdict === "approve") {
    await exec("gh", [
      "pr", "review", String(pr.number),
      "--approve",
      "--body", `✅ Aprobada por revisión automática de IA.\n\n${review.summary}`,
      "-R", config.repo,
    ], { env: ghEnv });
    return;
  }

  // request-changes con cuerpo detallado (vía --body-file para evitar límites).
  const bodyPath = join(tmpdir(), `pr-review-${randomUUID()}.md`);
  await writeFile(bodyPath, buildRequestChangesBody(review), "utf8");
  try {
    await exec("gh", [
      "pr", "review", String(pr.number),
      "--request-changes",
      "--body-file", bodyPath,
      "-R", config.repo,
    ], { env: ghEnv });
  } finally {
    unlink(bodyPath).catch(() => {});
  }
}

/** Revisa una única PR: prepara rama, lanza IA, parsea y aplica veredicto. */
async function reviewOnePr(
  dir: string,
  pr: PrInfo,
  budgetMs: number,
  onStatus: StatusFn,
): Promise<PrResult> {
  const base: PrResult = {
    number: pr.number,
    title: pr.title,
    author: pr.author,
    headRefName: pr.headRefName,
    applied: "error",
    summary: "",
    issuesCount: 0,
  };

  try {
    onStatus(`PR #${pr.number}: cargando rama`);
    await checkoutPrBranch(dir, pr);

    // Limpiar REVIEW.json de una ejecución previa.
    await unlink(join(dir, REVIEW_FILE)).catch(() => {});

    const diff = await prDiff(dir);
    const budgetMinutes = Math.max(1, Math.round(budgetMs / 60_000));
    const prompt = buildReviewPrompt(pr, diff, budgetMinutes);

    onStatus(`PR #${pr.number}: analizando con IA (~${budgetMinutes} min)`);
    const previousLimit = process.env.AGENT_MAX_RUNTIME_MS;
    process.env.AGENT_MAX_RUNTIME_MS = String(budgetMs);
    try {
      const execRes = await runAgentWithFallback(prompt, dir);
      base.solver = execRes.solver;
    } finally {
      if (previousLimit === undefined) delete process.env.AGENT_MAX_RUNTIME_MS;
      else process.env.AGENT_MAX_RUNTIME_MS = previousLimit;
    }

    onStatus(`PR #${pr.number}: procesando veredicto`);
    const review = await parseReview(dir);
    await unlink(join(dir, REVIEW_FILE)).catch(() => {});

    if (!review) {
      base.applied = "error";
      base.error = "No se pudo obtener un veredicto válido de la IA (REVIEW.json ausente o inválido).";
      base.summary = base.error;
      return base;
    }

    base.summary = review.summary;
    base.issuesCount = review.issues.length;

    onStatus(`PR #${pr.number}: aplicando ${review.verdict}`);
    await applyVerdict(pr, review);
    base.applied = review.verdict;
    return base;
  } catch (err) {
    base.applied = "error";
    base.error = (err as Error).message;
    base.summary = base.error;
    return base;
  }
}

/**
 * Ejecuta la validación completa.
 *  - Sin `only`: revisa todas las PRs abiertas hotfix/* -> hotfix-master.
 *  - Con `only`: revisa solo esa PR si cumple el criterio.
 */
export async function runValidatePrs(
  onStatus: StatusFn,
  opts: { only?: number; budgetMs?: number } = {},
): Promise<ValidateResult> {
  const budgetMs = opts.budgetMs ?? DEFAULT_REVIEW_BUDGET_MS;
  const result: ValidateResult = { ok: false, candidates: 0, results: [] };

  onStatus("listando PRs hotfix/*");
  let candidates: PrInfo[];
  try {
    candidates = await listCandidatePrs(opts.only);
  } catch (err) {
    result.error = `No se pudieron listar las PRs: ${(err as Error).message}`;
    return result;
  }

  result.candidates = candidates.length;
  if (candidates.length === 0) {
    result.ok = true;
    return result;
  }

  onStatus("preparando workspace");
  let dir: string;
  try {
    dir = await ensureWorkspace();
  } catch (err) {
    result.error = `No se pudo preparar el workspace: ${(err as Error).message}`;
    return result;
  }

  for (let i = 0; i < candidates.length; i++) {
    const pr = candidates[i];
    onStatus(`revisando PR ${i + 1}/${candidates.length} (#${pr.number})`);
    const res = await reviewOnePr(dir, pr, budgetMs, onStatus);
    result.results.push(res);
  }

  result.ok = true;
  return result;
}
