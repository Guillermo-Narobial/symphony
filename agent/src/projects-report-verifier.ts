import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { notifyEmail } from "./notifier-email.js";

const exec = promisify(execFile);

async function main(): Promise<void> {
  const { stdout } = await exec("systemctl", ["--user", "show", "symphony-projects-report.service", "-p", "Result", "-p", "ExecMainStatus", "-p", "ActiveExitTimestamp"]);
  const values = Object.fromEntries(stdout.trim().split("\n").map((line) => line.split("=", 2)));
  const healthy = values.Result === "success" && values.ExecMainStatus === "0";
  if (healthy) {
    console.log(`✅ Projects report verificado: ${values.ActiveExitTimestamp}`);
    return;
  }

  const detail = stdout.trim();
  await notifyEmail("🚨 [Symphony] Falló el informe diario de proyectos", `<h2>Informe diario no correcto</h2><pre>${detail}</pre>`);
  throw new Error(`Projects report verification failed: ${detail}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
