import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.js";

const exec = promisify(execFile);

function repoDir(url: string): string {
  return join(config.reposDir, basename(url, ".git"));
}

async function cloneOrPull(url: string): Promise<void> {
  const dir = repoDir(url);
  if (existsSync(join(dir, ".git"))) {
    await exec("git", ["-C", dir, "fetch", "origin", "--prune"]);
    // Pull la rama actual si tiene tracking
    try {
      const { stdout } = await exec("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = stdout.trim();
      await exec("git", ["-C", dir, "pull", "origin", branch, "--ff-only"]);
    } catch { /* rama sin tracking o con cambios locales — solo fetch es suficiente */ }
    console.log(`⬇️  pull ${basename(dir)}`);
  } else {
    await exec("git", ["clone", url, dir]);
    console.log(`📦 clone ${basename(dir)}`);
  }
}

export async function syncRepos(): Promise<void> {
  mkdirSync(config.reposDir, { recursive: true });
  await Promise.all(config.repos.map(cloneOrPull));
}
