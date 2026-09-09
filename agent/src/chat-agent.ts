/**
 * Orquestación de /chat [rama |] descripción.
 *
 * Lanza una sesión one-shot de kiro/codex (permisos completos) en un workspace
 * del frontend para ejecutar la consulta o desarrollo solicitado.
 *
 * Reglas estrictas:
 *  - NUNCA commitea ni pushea (lo decide el usuario después).
 *  - NUNCA cambia de rama por su cuenta. La rama la fija el usuario en la
 *    petición; sin rama, continúa en el workspace actual (encadenar peticiones).
 *  - El agente escribe su respuesta/resumen en CHAT_RESULT.md, que se reporta.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { AGENT_ENV, runAgentWithFallback } from "./agent-executor.js";
import { config } from "./config.js";

const exec = promisify(execFile);

const FRONTEND_REPO_URL =
  config.repos.find((url) => url.includes("Narobial-Frontend"))
  ?? "https://github.com/Narobial/Narobial-Frontend";
const RESULT_FILE = "CHAT_RESULT.md";
/** Tras este tiempo sin usar /chat, el workspace se resetea automáticamente. */
const INACTIVITY_RESET_MS = 2 * 60 * 60 * 1000; // 2 horas
const DEFAULT_RESET_BRANCH = "hotfix-master";

export interface ChatSpec {
  /** Rama sobre la que trabajar. Si es null, continúa en el workspace actual. */
  branch: string | null;
  description: string;
}

export interface ChatResult {
  ok: boolean;
  solver?: string;
  branch: string | null;
  /** Resumen escrito por el agente en CHAT_RESULT.md (o salida disponible). */
  agentSummary: string;
  /** git status --short del workspace tras la ejecución. */
  gitStatus: string;
  /** git diff --stat del workspace tras la ejecución. */
  gitDiffStat: string;
  /** true si el workspace se reseteó por inactividad (>2h) antes de ejecutar. */
  resetByInactivity?: boolean;
  error?: string;
}

type StatusFn = (phase: string) => void;

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await exec("git", args, { cwd, env: AGENT_ENV, maxBuffer: 1024 * 1024 * 10 });
    return (stdout || stderr || "").trim();
  } catch (err) {
    return `(git ${args[0]} no disponible: ${(err as Error).message})`;
  }
}

function chatWorkspaceDir(): string {
  return resolve(config.agentWorkspacesDir, "chat-workspace");
}

async function ensureWorkspace(): Promise<string> {
  const dir = chatWorkspaceDir();
  if (existsSync(resolve(dir, ".git"))) return dir;
  mkdirSync(resolve(config.agentWorkspacesDir), { recursive: true });
  await exec("git", ["clone", FRONTEND_REPO_URL, dir], {
    env: AGENT_ENV,
    maxBuffer: 1024 * 1024 * 20,
    timeout: 300_000,
  });
  return dir;
}

/** Fichero que guarda el timestamp del último uso de /chat. */
function activityFile(): string {
  return resolve(config.agentWorkspacesDir, ".chat-last-activity");
}

/** Devuelve ms desde el último /chat, o null si no hay registro previo. */
async function msSinceLastActivity(): Promise<number | null> {
  try {
    const raw = await readFile(activityFile(), "utf8");
    const ts = Number(raw.trim());
    if (!Number.isFinite(ts)) return null;
    return Date.now() - ts;
  } catch {
    return null;
  }
}

async function touchActivity(): Promise<void> {
  await writeFile(activityFile(), String(Date.now()), "utf8").catch(() => {});
}

/** Prepara el workspace en la rama indicada (reset limpio). */
async function checkoutBranch(dir: string, branch: string): Promise<void> {
  await git(dir, "fetch", "origin", "--prune");
  await git(dir, "reset", "--hard");
  await git(dir, "clean", "-fd");
  const co = await exec("git", ["-C", dir, "checkout", branch], { env: AGENT_ENV }).then(() => true).catch(() => false);
  if (!co) {
    await exec("git", ["-C", dir, "checkout", "-b", branch, `origin/${branch}`], { env: AGENT_ENV });
  }
  await git(dir, "reset", "--hard", `origin/${branch}`);
}

function buildChatPrompt(spec: ChatSpec, branch: string): string {
  return `# Petición vía /chat

Estás en el repositorio Narobial-Frontend, rama \`${branch}\`.

## Tarea solicitada

${spec.description}

## Reglas ESTRICTAS (obligatorias)

1. NO hagas \`git commit\` bajo ninguna circunstancia.
2. NO hagas \`git push\` bajo ninguna circunstancia.
3. NO cambies de rama, no hagas \`git checkout\` a otra rama, ni \`git reset\` a otra rama. Trabaja solo en \`${branch}\`.
4. NO improvises acciones fuera de lo solicitado. Si te falta información o crees que hace falta un paso adicional, NO lo ejecutes: descríbelo en el resultado para que el usuario lo autorice.
5. Puedes leer, analizar y modificar ficheros del working tree, y ejecutar comandos de solo lectura o de build/test si son necesarios para la tarea.

## Entrega

Escribe tu respuesta final en el fichero \`${RESULT_FILE}\` (en la raíz del repo), en español y de forma concreta, incluyendo:
- Qué has hecho o averiguado.
- Si has modificado ficheros, cuáles y por qué (sin commitear).
- Si necesitas ejecutar algo adicional o te falta información, indícalo claramente como "PENDIENTE / NECESITO" para que el usuario lo autorice en el siguiente /chat.`;
}

/**
 * Ejecuta la petición de /chat y devuelve el resultado con el resumen del
 * agente y el estado git (sin commitear ni pushear).
 */
export async function runChatTask(spec: ChatSpec, onStatus: StatusFn): Promise<ChatResult> {
  const result: ChatResult = {
    ok: false,
    branch: spec.branch,
    agentSummary: "",
    gitStatus: "",
    gitDiffStat: "",
  };

  onStatus("preparando workspace");
  const dir = await ensureWorkspace();

  // Rama: si el usuario la indica, se prepara; si no, se continúa en el estado actual.
  let branch: string;
  if (spec.branch) {
    await checkoutBranch(dir, spec.branch);
    branch = spec.branch;
  } else {
    // Sin rama = continuar. Pero si hubo >2h de inactividad, se resetea el
    // workspace (se descartan los cambios acumulados de sesiones previas).
    const idle = await msSinceLastActivity();
    if (idle !== null && idle > INACTIVITY_RESET_MS) {
      onStatus(`reset por inactividad (>${Math.round(INACTIVITY_RESET_MS / 3600000)}h)`);
      await checkoutBranch(dir, DEFAULT_RESET_BRANCH);
      branch = DEFAULT_RESET_BRANCH;
      result.resetByInactivity = true;
    } else {
      branch = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    }
  }
  result.branch = branch;

  // Registrar actividad al inicio para que el temporizador de inactividad
  // se mida desde la última petición.
  await touchActivity();

  onStatus(`ejecutando en ${branch}`);
  const prompt = buildChatPrompt(spec, branch);

  try {
    const exec = await runAgentWithFallback(prompt, dir);
    result.solver = exec.solver;
  } catch (err) {
    result.error = (err as Error).message;
    // Aun con error, intentamos leer lo que haya dejado el agente.
  }

  onStatus("recopilando resultado");
  result.agentSummary = await readFile(join(dir, RESULT_FILE), "utf8").catch(() => "(el agente no dejó CHAT_RESULT.md)");
  result.gitStatus = await git(dir, "status", "--short");
  result.gitDiffStat = await git(dir, "diff", "--stat");
  result.ok = !result.error;

  // Marca de actividad también al terminar (cubre ejecuciones largas).
  await touchActivity();

  return result;
}
