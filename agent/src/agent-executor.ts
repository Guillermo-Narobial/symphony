import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const NVM_PATH = "/home/gcalleja/.nvm/versions/node/v24.16.0/bin";

export const AGENT_ENV = {
  ...process.env,
  PATH: `${NVM_PATH}:/home/gcalleja/.local/bin:${process.env.PATH}`,
};

interface ProcessResult {
  code: number | null;
  stderr: string;
}

export interface AgentExecutionResult {
  solver: "kiro-cli" | "codex";
  code: number | null;
  usedFallback: boolean;
  fallbackReason?: string;
}

function tail(text: string, maxChars = 2_000): string {
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

async function runProcess(command: string, args: string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: AGENT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      process.stderr.write(d);
    });

    proc.on("close", (code) => resolve({ code, stderr }));
    proc.on("error", reject);
  });
}

async function runKiro(prompt: string, cwd: string): Promise<ProcessResult> {
  try {
    await exec("kiro-cli", ["agent", "set-default", "narobial-frontend"], { env: AGENT_ENV });
  } catch (err) {
    return {
      code: 1,
      stderr: `kiro-cli agent set-default failed: ${(err as Error).message}`,
    };
  }

  return runProcess("kiro-cli", [
    "chat",
    "--agent", "narobial-frontend",
    "--no-interactive",
    "--trust-all-tools",
    prompt,
  ], cwd);
}

async function runCodex(prompt: string, cwd: string): Promise<ProcessResult> {
  return runProcess("codex", [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    prompt,
  ], cwd);
}

export async function runAgentWithFallback(
  prompt: string,
  cwd: string,
  opts: { forceCodex?: boolean } = {},
): Promise<AgentExecutionResult> {
  if (!opts.forceCodex) {
    const kiro = await runKiro(prompt, cwd);
    if (kiro.code === 0) {
      return { solver: "kiro-cli", code: kiro.code, usedFallback: false };
    }

    const reason = `kiro-cli exited ${kiro.code}: ${tail(kiro.stderr)}`;
    console.warn(`⚠️  ${reason}`);
    console.warn("↪️  Reintentando con codex...");

    const codex = await runCodex(
      `${prompt}

## Nota de orquestación

El intento previo con kiro-cli falló. Continúa desde el estado actual del workspace y completa la tarea con Codex.`,
      cwd,
    );

    if (codex.code !== 0) {
      throw new Error(`codex fallback exited ${codex.code}: ${tail(codex.stderr)}`);
    }

    return {
      solver: "codex",
      code: codex.code,
      usedFallback: true,
      fallbackReason: reason,
    };
  }

  const codex = await runCodex(prompt, cwd);
  if (codex.code !== 0) {
    throw new Error(`codex exited ${codex.code}: ${tail(codex.stderr)}`);
  }

  return { solver: "codex", code: codex.code, usedFallback: false };
}
