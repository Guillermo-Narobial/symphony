/**
 * Orquestación de /merge <número_pr>.
 *
 * Flujo:
 *  1. gh pr view → obtiene rama head y estado.
 *  2. Prepara un workspace aislado del repo Narobial-Frontend en hotfix-master.
 *  3. git merge de la rama de la PR contra hotfix-master.
 *  4. Si hay conflictos → lanza el agente (kiro/codex, permisos amplios) para
 *     resolverlos, luego commitea.
 *  5. push de hotfix-master.
 *  6. Borra la rama de la PR (nunca hotfix-master).
 *
 * Emite progreso mediante el callback onStatus (para el status periódico).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { AGENT_ENV, runAgentWithFallback } from "./agent-executor.js";
import { config } from "./config.js";

const exec = promisify(execFile);

const BASE_BRANCH = "hotfix-master";
const FRONTEND_REPO_URL =
  config.repos.find((url) => url.includes("Narobial-Frontend"))
  ?? "https://github.com/Narobial/Narobial-Frontend";

export interface MergeResult {
  ok: boolean;
  prNumber: number;
  headBranch?: string;
  hadConflicts: boolean;
  solver?: string;
  branchDeleted: boolean;
  summary: string;
}

type StatusFn = (phase: string) => void;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: AGENT_ENV, maxBuffer: 1024 * 1024 * 20 });
  return stdout.trim();
}

/** git que no lanza excepción; devuelve {ok, out}. */
async function gitSafe(cwd: string, ...args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(cwd, ...args) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: (e.stderr || e.stdout || e.message || "").trim() };
  }
}

/** Workspace aislado para operaciones de merge. */
function mergeWorkspaceDir(): string {
  return resolve(config.agentWorkspacesDir, "merge-workspace");
}

async function ensureWorkspace(): Promise<string> {
  const dir = mergeWorkspaceDir();
  if (existsSync(resolve(dir, ".git"))) return dir;
  mkdirSync(resolve(config.agentWorkspacesDir), { recursive: true });
  await exec("git", ["clone", FRONTEND_REPO_URL, dir], {
    env: AGENT_ENV,
    maxBuffer: 1024 * 1024 * 20,
    timeout: 300_000,
  });
  return dir;
}

async function prepareBase(dir: string): Promise<void> {
  await git(dir, "fetch", "origin", "--prune");
  await git(dir, "reset", "--hard");
  await git(dir, "clean", "-fd");
  const co = await gitSafe(dir, "checkout", BASE_BRANCH);
  if (!co.ok) {
    await git(dir, "checkout", "-b", BASE_BRANCH, `origin/${BASE_BRANCH}`);
  }
  await git(dir, "reset", "--hard", `origin/${BASE_BRANCH}`);
}

function buildConflictPrompt(prNumber: number, headBranch: string, conflicts: string): string {
  return `# Resolución de conflictos de merge — PR #${prNumber}

Estás en el repositorio Narobial-Frontend, rama \`${BASE_BRANCH}\`.
Se ha iniciado un \`git merge\` de la rama \`${headBranch}\` (PR #${prNumber}) y hay CONFLICTOS sin resolver.

## Ficheros en conflicto

${conflicts}

## Tu tarea

1. Resuelve TODOS los conflictos de merge de forma coherente, preservando la intención de ambos lados cuando aplique.
2. NO hagas \`git merge --abort\` ni \`git reset\`. Debes completar el merge.
3. Marca los ficheros resueltos con \`git add\` y crea el commit de merge (\`git commit --no-edit\` o con un mensaje descriptivo).
4. Asegúrate de que el árbol queda sin marcas de conflicto (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).
5. No hagas push (lo hará el orquestador).

Trabaja únicamente en este repositorio y deja el merge commit creado.`;
}

async function hasConflicts(dir: string): Promise<string[]> {
  const out = await git(dir, "diff", "--name-only", "--diff-filter=U");
  return out ? out.split("\n").filter(Boolean) : [];
}

async function isMergeInProgress(dir: string): Promise<boolean> {
  return existsSync(resolve(dir, ".git", "MERGE_HEAD"));
}

/**
 * Ejecuta el flujo completo de merge de una PR contra hotfix-master.
 */
export async function runMergePr(prNumber: number, onStatus: StatusFn): Promise<MergeResult> {
  const base: MergeResult = {
    ok: false,
    prNumber,
    hadConflicts: false,
    branchDeleted: false,
    summary: "",
  };

  // 1. Metadatos de la PR
  onStatus("consultando PR");
  const prView = await exec("gh", [
    "pr", "view", String(prNumber),
    "-R", config.repo,
    "--json", "number,state,baseRefName,headRefName,isCrossRepository",
  ], { env: AGENT_ENV }).catch((e) => {
    throw new Error(`No se pudo leer la PR #${prNumber}: ${(e as Error).message}`);
  });
  const pr = JSON.parse(prView.stdout) as {
    state: string;
    baseRefName: string;
    headRefName: string;
    isCrossRepository: boolean;
  };
  base.headBranch = pr.headRefName;

  if (pr.isCrossRepository) {
    return { ...base, summary: `PR #${prNumber} viene de un fork (cross-repo); no soportado por seguridad.` };
  }
  if (pr.state === "MERGED") {
    return { ...base, summary: `PR #${prNumber} ya está MERGED.` };
  }
  if (pr.state === "CLOSED") {
    return { ...base, summary: `PR #${prNumber} está CLOSED; no se mergea.` };
  }

  const headBranch = pr.headRefName;

  // 2. Preparar workspace en hotfix-master
  onStatus("preparando workspace");
  const dir = await ensureWorkspace();
  await prepareBase(dir);

  // 3. Traer la rama de la PR e intentar el merge
  onStatus("intentando merge");
  await git(dir, "fetch", "origin", headBranch);
  const merge = await gitSafe(dir, "merge", "--no-ff", `origin/${headBranch}`, "-m", `Merge PR #${prNumber} (${headBranch}) into ${BASE_BRANCH}`);

  let hadConflicts = false;
  let solver: string | undefined;

  if (!merge.ok) {
    const conflicts = await hasConflicts(dir);
    if (conflicts.length === 0 && !(await isMergeInProgress(dir))) {
      // Falló por otra razón (no conflicto)
      return { ...base, headBranch, summary: `Falló el merge de PR #${prNumber}: ${merge.out}` };
    }

    // 4. Resolver conflictos con IA
    hadConflicts = true;
    onStatus(`resolviendo ${conflicts.length} conflicto(s) con IA`);
    const prompt = buildConflictPrompt(prNumber, headBranch, conflicts.map((c) => `- ${c}`).join("\n"));
    try {
      const exec = await runAgentWithFallback(prompt, dir);
      solver = exec.solver;
    } catch (err) {
      await gitSafe(dir, "merge", "--abort");
      return { ...base, headBranch, hadConflicts: true, summary: `El agente no pudo resolver los conflictos de PR #${prNumber}: ${(err as Error).message}` };
    }

    // Verificar que no quedan conflictos y que el merge se completó
    const remaining = await hasConflicts(dir);
    if (remaining.length > 0) {
      await gitSafe(dir, "merge", "--abort");
      return { ...base, headBranch, hadConflicts: true, solver, summary: `Quedan conflictos sin resolver en PR #${prNumber}: ${remaining.join(", ")}` };
    }
    if (await isMergeInProgress(dir)) {
      // El agente resolvió pero no commiteó → commiteamos nosotros
      await gitSafe(dir, "add", "-A");
      const commit = await gitSafe(dir, "commit", "--no-edit");
      if (!commit.ok) {
        return { ...base, headBranch, hadConflicts: true, solver, summary: `No se pudo crear el commit de merge de PR #${prNumber}: ${commit.out}` };
      }
    }
  }

  // 5. Push de hotfix-master
  onStatus("push a hotfix-master");
  const push = await gitSafe(dir, "push", "origin", BASE_BRANCH);
  if (!push.ok) {
    return { ...base, headBranch, hadConflicts, solver, summary: `Merge realizado en local pero falló el push de ${BASE_BRANCH}: ${push.out}` };
  }

  // 6. Borrar la rama de la PR (nunca hotfix-master)
  let branchDeleted = false;
  if (headBranch && headBranch !== BASE_BRANCH) {
    onStatus("borrando rama");
    const del = await gitSafe(dir, "push", "origin", "--delete", headBranch);
    branchDeleted = del.ok;
  }

  const parts = [
    `✅ PR #${prNumber} mergeada en ${BASE_BRANCH}.`,
    hadConflicts ? `🤖 Conflictos resueltos con ${solver ?? "IA"}.` : "🟢 Sin conflictos.",
    branchDeleted ? `🗑️ Rama \`${headBranch}\` eliminada.` : `⚠️ La rama \`${headBranch}\` no se pudo eliminar.`,
  ];
  return {
    ok: true,
    prNumber,
    headBranch,
    hadConflicts,
    solver,
    branchDeleted,
    summary: parts.join("\n"),
  };
}
