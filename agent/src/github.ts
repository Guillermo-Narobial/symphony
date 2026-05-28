import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { Task } from "./schema.js";

const exec = promisify(execFile);

export async function createIssue(task: Task): Promise<string> {
  const label = task.isProject ? "proyecto" : "incidencia";
  const { stdout } = await exec("gh", [
    "issue", "create",
    "--repo", config.repo,
    "--title", `[DMS-${task.id}] ${task.title}`,
    "--body", task.requirements || task.customerRequirements || "Sin descripción",
    "--label", label,
  ]);
  return stdout.trim();
}
