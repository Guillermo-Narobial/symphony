import "dotenv/config";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);
const statePath = "/home/gcalleja/code/symphony-logs/quality-trends.json";

interface Report { date: string; total: number; weak: number; borderline: number; noMutants: number; skipped: unknown[]; }

async function main(): Promise<void> {
  const { stdout } = await exec("find", ["/tmp", "-path", "*symphony-mutator-*/*/reports/mutation/mutation.json", "-type", "f"], { timeout: 30_000 });
  const reports = await Promise.all(stdout.trim().split("\n").filter(Boolean).map(async (file) => JSON.parse(await readFile(file, "utf8")) as Report));
  reports.sort((left, right) => left.date.localeCompare(right.date));
  const current = reports.at(-1);
  const previous = reports.at(-2);
  if (!current) return;
  await writeFile(statePath, JSON.stringify({ updatedAt: new Date().toISOString(), current, previous }, null, 2));
  if (!previous) return;
  const regressions: string[] = [];
  for (const key of ["weak", "borderline", "noMutants"] as const) if (current[key] > previous[key]) regressions.push(key);
  if (current.skipped.length > previous.skipped.length) regressions.push("skipped");
  if (!regressions.length) { console.log("✅ Sin regresión semanal de calidad"); return; }
  const body = ["## Regresión de calidad semanal", "", "Métricas: " + regressions.join(", "), "", "- Weak: " + previous.weak + " -> " + current.weak, "- Borderline: " + previous.borderline + " -> " + current.borderline, "- Sin mutantes: " + previous.noMutants + " -> " + current.noMutants, "- Skips: " + previous.skipped.length + " -> " + current.skipped.length].join("\n");
  await exec("gh", ["issue", "create", "-R", config.repo, "--title", "test(quality): regresión semanal " + regressions.join(", "), "--body", body, "--label", "audit:testing", "--assignee", config.rejectAssignee]);
}

main().catch((error) => { console.error(error); process.exit(1); });
