import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { notifyEmail } from "./notifier-email.js";
import { isReportHealthy, localDateKey } from "./projects-report-verifier-logic.js";

export { isReportHealthy, localDateKey } from "./projects-report-verifier-logic.js";

const exec = promisify(execFile);

async function main(): Promise<void> {
  const { stdout } = await exec("systemctl", ["--user", "show", "symphony-projects-report.service", "-p", "Result", "-p", "ExecMainStatus", "-p", "ActiveExitTimestamp", "-p", "ExecMainExitTimestamp"]);
  const values = Object.fromEntries(stdout.trim().split("\n").map((line) => {
    const [key, ...rest] = line.split("=");
    return [key, rest.join("=")];
  }));
  const expectedDate = localDateKey(new Date());
  const healthy = isReportHealthy(values, expectedDate);
  if (healthy) {
    console.log("✅ Projects report verificado: " + values.ActiveExitTimestamp);
    return;
  }

  const detail = stdout.trim() + "\nExpected ActiveExitTimestamp/ExecMainExitTimestamp date: " + expectedDate;
  await notifyEmail("🚨 [Symphony] Falló el informe diario de proyectos", "<h2>Informe diario no correcto</h2><pre>" + detail + "</pre>");
  throw new Error("Projects report verification failed: " + detail);
}

main().catch((error) => { console.error(error); process.exit(1); });
