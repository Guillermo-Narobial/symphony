import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.js";

const exec = promisify(execFile);

function repoDir(url: string): string {
  return join(config.reposDir, basename(url, ".git"));
}

/**
 * Detecta un estado de índice corrupto: ficheros en conflicto (unmerged)
 * sin un merge/rebase realmente en curso. Ese estado hace que cualquier
 * `git stash push` posterior falle, bloqueando la sincronización en bucle.
 */
async function hasUnmergedPaths(dir: string): Promise<boolean> {
  const { stdout } = await exec("git", ["-C", dir, "diff", "--name-only", "--diff-filter=U"]);
  return stdout.trim().length > 0;
}

/**
 * Deja el repo de trabajo en un estado limpio alineado con origin/branch.
 * Estos repos son clones desechables del agente; ante corrupción o
 * conflictos irreconciliables se prioriza un árbol limpio y sincronizado.
 */
async function resetToOrigin(dir: string, branch: string): Promise<void> {
  await exec("git", ["-C", dir, "merge", "--abort"]).catch(() => {});
  await exec("git", ["-C", dir, "rebase", "--abort"]).catch(() => {});
  await exec("git", ["-C", dir, "reset", "--hard", `origin/${branch}`]);
  await exec("git", ["-C", dir, "clean", "-fd"]).catch(() => {});
}

async function cloneOrPull(url: string): Promise<void> {
  const dir = repoDir(url);
  if (!existsSync(join(dir, ".git"))) { await exec("git", ["clone", url, dir]); console.log("📦 clone " + basename(dir)); return; }

  await exec("git", ["-C", dir, "fetch", "origin", "--prune"]);
  const { stdout } = await exec("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = stdout.trim();

  // Auto-recuperación: si el árbol quedó con conflictos sin resolver de una
  // sincronización previa fallida, resetear a origin antes de continuar.
  if (await hasUnmergedPaths(dir)) {
    console.warn("⚠️  " + basename(dir) + ": conflictos sin resolver detectados; regenerando rama desde origin/" + branch);
    await resetToOrigin(dir, branch);
    console.log("⬇️  pull " + basename(dir) + " (regenerado)");
    return;
  }

  const { stdout: porcelain } = await exec("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all"]);
  const hasLocalChanges = porcelain.trim().length > 0;

  if (hasLocalChanges) await exec("git", ["-C", dir, "stash", "push", "--include-untracked", "-m", "symphony-sync-preserve-local"]);

  try {
    await exec("git", ["-C", dir, "pull", "origin", branch, "--ff-only"]);
  } finally {
    if (hasLocalChanges) {
      try {
        await exec("git", ["-C", dir, "stash", "pop"]);
      } catch (error) {
        // El pop generó conflictos. En lugar de dejar el repo bloqueado en
        // bucle, se preservan los cambios en el stash y se limpia el árbol
        // para que la próxima sincronización no vuelva a fallar.
        await resetToOrigin(dir, branch);
        console.warn(
          "⚠️  " + basename(dir) + ": conflictos al restaurar cambios locales; " +
          "el stash se conserva (git stash list) y el árbol se ha regenerado desde origin/" + branch +
          ". Detalle: " + (error as Error).message,
        );
        return;
      }
    }
  }
  console.log("⬇️  pull " + basename(dir));
}

export async function syncRepos(): Promise<void> {
  mkdirSync(config.reposDir, { recursive: true });
  await Promise.all(config.repos.map(cloneOrPull));
}
