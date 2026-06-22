import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { config } from "./config.js";
import { notifyEmail } from "./notifier-email.js";

const exec = promisify(execFile);
const MAX_ATTEMPTS = 2;
const LOG_DIR = resolve("/home/gcalleja/code/symphony-logs");
const RUN_KIND = process.env.MUTATOR_RUN_KIND === "weekly" ? "weekly" : "manual";
const FILE_PREFIX = `mutator-${RUN_KIND}`;
const RUN_LABEL = RUN_KIND === "weekly" ? "semanal" : "manual";
const STATE_PATH = resolve(LOG_DIR, `${FILE_PREFIX}-state.json`);
const PID_PATH = resolve(LOG_DIR, `${FILE_PREFIX}.pid`);
const PROGRESS_PATH = resolve(LOG_DIR, `${FILE_PREFIX}-progress.json`);

const agentDir = resolve("/home/gcalleja/code/symphony/agent");
const baseRepo = resolve(config.frontendRepoDir);

interface RunnerState {
  status: "starting" | "cloning" | "running" | "retrying" | "completed" | "failed";
  startedAt: string;
  updatedAt: string;
  baseRepo: string;
  logPath: string;
  progressPath: string;
  attempt: number;
  maxAttempts: number;
  cloneDir?: string;
  runnerPid: number;
  workerPid?: number;
  error?: string;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeState(state: RunnerState): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadState(): Promise<RunnerState | null> {
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

async function cloneFrontend(attempt: number): Promise<string> {
  const runRoot = resolve(tmpdir(), `symphony-mutator-${RUN_KIND}-${timestamp()}-attempt-${attempt}`);
  const cloneDir = resolve(runRoot, "Narobial-Frontend");

  await mkdir(runRoot, { recursive: true });
  await exec("git", ["clone", "--local", "--no-hardlinks", baseRepo, cloneDir], {
    cwd: agentDir,
    maxBuffer: 20 * 1024 * 1024,
  });

  return cloneDir;
}

async function resolveCloneDir(attempt: number, resumableCloneDir?: string): Promise<string> {
  if (resumableCloneDir) return resumableCloneDir;
  return cloneFrontend(attempt);
}

async function runMutator(cloneDir: string, logPath: string, attempt: number, startedAt: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const log = createWriteStream(logPath, { flags: "a" });
    const child = spawn("/usr/bin/npx", ["tsx", "src/mutator.ts"], {
      cwd: agentDir,
      env: { ...process.env, FRONTEND_REPO_DIR: cloneDir, MUTATOR_PROGRESS_PATH: PROGRESS_PATH, MUTATOR_RUN_KIND: RUN_KIND },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const header =
      `\n=== Attempt ${attempt}/${MAX_ATTEMPTS} @ ${new Date().toISOString()} ===\n` +
      `Base repo: ${baseRepo}\nClone dir: ${cloneDir}\nProgress: ${PROGRESS_PATH}\n\n`;
    process.stdout.write(header);
    log.write(header);
    void writeState({
      status: "running",
      startedAt,
      updatedAt: new Date().toISOString(),
      baseRepo,
      logPath,
      progressPath: PROGRESS_PATH,
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      cloneDir,
      runnerPid: process.pid,
      workerPid: child.pid,
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });

    child.on("error", (error) => {
      log.end();
      rejectRun(error);
    });

    child.on("close", (code, signal) => {
      log.end();
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`mutator exit code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

async function main(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(PID_PATH, `${process.pid}\n`);

  const previous = await loadState();
  if (previous && await isPidAlive(previous.runnerPid) && previous.runnerPid !== process.pid) {
    throw new Error(`ya hay un mutator ${RUN_LABEL} en ejecución (pid ${previous.runnerPid})`);
  }

  const resumablePrevious = previous && !["completed", "failed"].includes(previous.status) ? previous : null;
  const startedAt = resumablePrevious?.startedAt ?? new Date().toISOString();
  const logPath = resumablePrevious?.logPath ?? resolve(LOG_DIR, `${FILE_PREFIX}-${timestamp()}.log`);
  let lastError: unknown;

  await writeState({
    status: "starting",
    startedAt,
    updatedAt: new Date().toISOString(),
    baseRepo,
    logPath,
    progressPath: PROGRESS_PATH,
    attempt: 0,
    maxAttempts: MAX_ATTEMPTS,
    cloneDir: resumablePrevious?.cloneDir,
    runnerPid: process.pid,
  });

  const startAttempt = resumablePrevious && resumablePrevious.attempt > 0 ? resumablePrevious.attempt : 1;

  for (let attempt = startAttempt; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await writeState({
        status: "cloning",
        startedAt,
        updatedAt: new Date().toISOString(),
        baseRepo,
        logPath,
        progressPath: PROGRESS_PATH,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        cloneDir: resumablePrevious?.cloneDir,
        runnerPid: process.pid,
      });
      const cloneDir = await resolveCloneDir(attempt, resumablePrevious?.cloneDir);
      await writeState({
        status: "cloning",
        startedAt,
        updatedAt: new Date().toISOString(),
        baseRepo,
        logPath,
        progressPath: PROGRESS_PATH,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        cloneDir,
        runnerPid: process.pid,
      });
      await runMutator(cloneDir, logPath, attempt, startedAt);
      await writeState({
        status: "completed",
        startedAt,
        updatedAt: new Date().toISOString(),
        baseRepo,
        logPath,
        progressPath: PROGRESS_PATH,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        cloneDir,
        runnerPid: process.pid,
      });
      console.log(`✅ Mutator completado. Log: ${logPath}`);
      return;
    } catch (error) {
      lastError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const current = await loadState();
      await writeState({
        status: attempt < MAX_ATTEMPTS ? "retrying" : "failed",
        startedAt,
        updatedAt: new Date().toISOString(),
        baseRepo,
        logPath,
        progressPath: PROGRESS_PATH,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        cloneDir: current?.cloneDir ?? resumablePrevious?.cloneDir,
        runnerPid: process.pid,
        error: errorMessage,
      });
      console.error(`❌ Intento ${attempt}/${MAX_ATTEMPTS} fallido: ${(error as Error).message}`);
    }
  }

  const reason = lastError instanceof Error ? lastError.stack ?? lastError.message : String(lastError);
  await notifyEmail(
    `❌ [Symphony] Mutation testing ${RUN_LABEL} fallido — ${new Date().toISOString().slice(0, 10)}`,
    `<h2>Mutation testing ${RUN_LABEL} fallido</h2><p>Se agotaron ${MAX_ATTEMPTS} intentos.</p><p><strong>Repo base:</strong> <code>${baseRepo}</code></p><p><strong>Log:</strong> <code>${logPath}</code></p><p><strong>Progress:</strong> <code>${PROGRESS_PATH}</code></p><pre>${reason}</pre>`
  );
  process.exit(1);
}

main().catch(async (error) => {
  const reason = error instanceof Error ? error.stack ?? error.message : String(error);
  const current = await loadState();
  await writeState({
    status: "failed",
    startedAt: current?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baseRepo,
    logPath: current?.logPath ?? resolve(LOG_DIR, `${FILE_PREFIX}-crash-${timestamp()}.log`),
    progressPath: PROGRESS_PATH,
    attempt: current?.attempt ?? 0,
    maxAttempts: MAX_ATTEMPTS,
    cloneDir: current?.cloneDir,
    runnerPid: process.pid,
    error: reason,
  });
  try {
    await notifyEmail(
      `❌ [Symphony] Mutation runner ${RUN_LABEL} crash — ${new Date().toISOString().slice(0, 10)}`,
      `<h2>Mutation runner ${RUN_LABEL} crash</h2><pre>${reason}</pre>`
    );
  } catch {}
  console.error(reason);
  process.exit(1);
});
