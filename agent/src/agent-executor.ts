import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const NVM_PATH = "/home/gcalleja/.nvm/versions/node/v24.16.0/bin";

export const AGENT_ENV = {
  ...process.env,
  PATH: `${NVM_PATH}:/home/gcalleja/.local/bin:${process.env.PATH}`,
};

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

type CodexLimitKind = "none" | "session" | "account";

export interface AgentExecutionResult {
  solver: "kiro-cli" | "codex";
  code: number | null;
  usedFallback: boolean;
  fallbackReason?: string;
}

function tail(text: string, maxChars = 2_000): string {
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

function combinedOutput(result: ProcessResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

async function runProcess(command: string, args: string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: AGENT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      process.stdout.write(d);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      process.stderr.write(d);
    });

    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.on("error", reject);
  });
}

async function runKiro(prompt: string, cwd: string): Promise<ProcessResult> {
  try {
    await exec("kiro-cli", ["agent", "set-default", "narobial-frontend"], { env: AGENT_ENV });
  } catch (err) {
    return {
      code: 1,
      stdout: "",
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

function kiroOutOfCredits(result: ProcessResult): boolean {
  const output = combinedOutput(result).toLowerCase();
  return [
    "the limits reset on",
    "contact your administrator for account management",
    "credits",
    "creditos",
    "quota",
    "rate limit",
  ].some((needle) => output.includes(needle));
}

function classifyCodexLimit(result: ProcessResult): CodexLimitKind {
  const output = combinedOutput(result).toLowerCase();
  const hardAccountMarkers = [
    "you\'ve hit your usage limit",
    "you have hit your usage limit",
    "try again at",
    "limits reset",
    "the limits reset on",
    "contact your administrator for account management",
  ];
  const accountMarkers = [
    "account limit",
    "organization limit",
    "usage limit",
    "rate limit",
    "quota",
    "credits",
    "creditos",
    "sin creditos",
    "limite de uso",
    "límite de uso",
  ];
  const sessionMarkers = [
    "session limit",
    "current session",
    "new session",
    "start a new session",
    "tab limit",
    "current tab",
    "window limit",
    "conversation limit",
    "this conversation",
    "context window",
    "context limit",
    "context length",
    "maximum context",
    "pestana",
    "pestaña",
    "sesion",
    "sesión",
  ];

  if (hardAccountMarkers.some((needle) => output.includes(needle))) return "account";
  if (sessionMarkers.some((needle) => output.includes(needle))) return "session";
  if (accountMarkers.some((needle) => output.includes(needle))) return "account";
  return "none";
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await exec("git", args, {
      cwd,
      env: AGENT_ENV,
      maxBuffer: 1024 * 1024,
    });
    return (stdout || stderr || "").trim() || "(sin salida)";
  } catch (err) {
    return `No disponible: ${(err as Error).message}`;
  }
}

async function writeCodexHandoff(
  prompt: string,
  cwd: string,
  result: ProcessResult,
  limitKind: CodexLimitKind,
): Promise<string> {
  const handoffPath = join(cwd, "CODEX_HANDOFF.md");
  const [status, diffStat, recentLog] = await Promise.all([
    gitOutput(cwd, ["status", "--short"]),
    gitOutput(cwd, ["diff", "--stat"]),
    gitOutput(cwd, ["log", "--oneline", "-5"]),
  ]);
  const outputTail = tail(combinedOutput(result), 4_000).trim() || "(sin salida capturada)";
  const promptTail = tail(prompt, 4_000).trim() || "(prompt no disponible)";

  await writeFile(handoffPath, `# Codex handoff

Generated: ${new Date().toISOString()}
Workspace: ${cwd}
Limit kind: ${limitKind}

## Resume rule

Open a fresh Codex session in this workspace, read this file, inspect \`git status\` and \`git diff\`, and continue from the current state without resetting or discarding changes.

## Current git status

\`\`\`text
${status}
\`\`\`

## Current diff stat

\`\`\`text
${diffStat}
\`\`\`

## Recent commits

\`\`\`text
${recentLog}
\`\`\`

## Latest Codex output

\`\`\`text
${outputTail}
\`\`\`

## Continuation prompt

\`\`\`text
Lee CODEX_HANDOFF.md, revisa git status y git diff, y continua exactamente desde el estado actual. No reinicies el trabajo, no hagas git reset y conserva los cambios ya aplicados.
\`\`\`

## Previous prompt tail

\`\`\`text
${promptTail}
\`\`\`
`, "utf8");

  return handoffPath;
}

async function failCodexRun(context: string, prompt: string, cwd: string, result: ProcessResult): Promise<never> {
  const limitKind = classifyCodexLimit(result);
  const output = tail(combinedOutput(result));
  if (limitKind === "session") {
    const handoffPath = await writeCodexHandoff(prompt, cwd, result, limitKind);
    throw new Error(`${context} hit a session/tab/context Codex limit. Handoff written to ${handoffPath}. Start a fresh Codex session in the same workspace and resume from CODEX_HANDOFF.md. Last output: ${output}`);
  }
  if (limitKind === "account") {
    throw new Error(`${context} hit a Codex account/time quota. Do not retry until the reset time. Last output: ${output}`);
  }
  throw new Error(`${context} exited ${result.code}: ${output}`);
}

export async function runAgentWithFallback(
  prompt: string,
  cwd: string,
  opts: { forceCodex?: boolean } = {},
): Promise<AgentExecutionResult> {
  if (!opts.forceCodex) {
    const kiro = await runKiro(prompt, cwd);
    const exhausted = kiroOutOfCredits(kiro);

    if (kiro.code === 0 && !exhausted) {
      return { solver: "kiro-cli", code: kiro.code, usedFallback: false };
    }

    const reason = exhausted
      ? `kiro-cli exhausted credits/quota: ${tail(combinedOutput(kiro))}`
      : `kiro-cli exited ${kiro.code}: ${tail(kiro.stderr)}`;
    console.warn(`⚠️  ${reason}`);
    console.warn("↪️  Reintentando con codex...");

    const fallbackPrompt = `${prompt}

## Nota de orquestación

El intento previo con kiro-cli falló. Continúa desde el estado actual del workspace y completa la tarea con Codex.`;
    const codex = await runCodex(fallbackPrompt, cwd);

    if (codex.code !== 0) {
      await failCodexRun("codex fallback", fallbackPrompt, cwd, codex);
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
    await failCodexRun("codex", prompt, cwd, codex);
  }

  return { solver: "codex", code: codex.code, usedFallback: false };
}
