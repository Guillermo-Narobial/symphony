import "dotenv/config";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const LOG_DIR = resolve("/home/gcalleja/code/symphony-logs");
const PID_PATH = resolve(LOG_DIR, "mutator-manual.pid");
const STATE_PATH = resolve(LOG_DIR, "mutator-manual-state.json");

interface RunnerState {
  runnerPid: number;
  status: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadState(): Promise<RunnerState | null> {
  if (!await pathExists(STATE_PATH)) return null;
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    return JSON.parse(raw) as RunnerState;
  } catch {
    return null;
  }
}

async function isPidAlive(pid: number | undefined): Promise<boolean> {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });

  const existing = await loadState();
  if (existing && await isPidAlive(existing.runnerPid)) {
    console.log(`⏭️  Ya hay un mutator manual en ejecución (pid ${existing.runnerPid}, estado ${existing.status})`);
    console.log(`State: ${STATE_PATH}`);
    return;
  }

  const child = spawn("/usr/bin/npx", ["tsx", "src/mutator-runner.ts"], {
    cwd: "/home/gcalleja/code/symphony/agent",
    env: { ...process.env, MUTATOR_RUN_KIND: "manual" },
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  await writeFile(PID_PATH, `${child.pid}\n`);

  console.log("✅ Mutator manual lanzado en background");
  console.log(`PID: ${child.pid}`);
  console.log(`State: ${STATE_PATH}`);
  console.log(`PID file: ${PID_PATH}`);
}

main().catch((error) => {
  const reason = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`❌ No se pudo lanzar el mutator manual: ${reason}`);
  process.exit(1);
});
