import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);

export async function notifyRejection(taskId: string, reason: string): Promise<string> {
  const title = `[Rechazada] Tarea ${taskId}`;
  const body = `@${config.rejectAssignee} esta tarea no cumple la plantilla.\n\n**Motivo:**\n${reason}`;

  const { stdout } = await exec("gh", [
    "issue", "create",
    "--repo", config.repo,
    "--title", title,
    "--body", body,
    "--assignee", config.rejectAssignee,
    "--label", "rechazada",
  ]);
  return stdout.trim();
}
