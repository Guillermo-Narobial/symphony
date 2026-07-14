import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { AGENT_ENV } from "./agent-executor.js";
import { config } from "./config.js";
import { notifyAgentFailureEmail } from "./notifier-email.js";
import { formatRouterDecision, routeIssue, type RouterDecision } from "./llm-router.js";
import { branchNameForIssue } from "./runner.js";
import { runAgent } from "./runner.js";

const exec = promisify(execFile);

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

interface OpenPr {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  url: string;
}

interface FailureRetryState {
  attempt: number;
  retryAfter: Date;
}

interface ScoredIssue {
  issue: GitHubIssue;
  score: number;
}

interface AgentLaunchPlan extends ScoredIssue {
  baseBranch: string;
  forceCodex: boolean;
  previousFailureContext: string;
  routerDecision: RouterDecision;
}

const running = new Set<number>();
const FAILED_LABEL = "agent-failed";
const RETRY_LABEL_PREFIX = "agent-retry:";
const FAILURE_MARKER_RE = /<!-- symphony-agent-failure attempt=(\d+) retryAfter=([^\s]+) -->/;
const BRANCH_CLEANUP_INTERVAL_MS = 6 * 60 * 60_000;
const QUOTA_RETRY_DELAY_MS = 10 * 60 * 60_000;
let lastBranchCleanupAt = 0;

async function fetchOpenIssues(label?: string): Promise<GitHubIssue[]> {
  const args = [
    "issue", "list",
    "--repo", config.repo,
    "--state", "open",
    "--json", "number,title,body,labels",
    "--limit", "100",
  ];
  if (label) args.push("--label", label);

  const { stdout } = await exec("gh", args, { env: AGENT_ENV });
  const raw = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
  }>;
  return raw.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    labels: i.labels.map((l) => l.name),
  }));
}

async function fetchOpenPullRequests(): Promise<OpenPr[]> {
  const { stdout } = await exec("gh", [
    "pr", "list",
    "-R", config.repo,
    "--state", "open",
    "--json", "number,title,body,headRefName,url",
    "--limit", "100",
  ], { env: AGENT_ENV });
  return JSON.parse(stdout) as OpenPr[];
}

function findOpenPrForIssue(issue: GitHubIssue, branch: string, openPrs: OpenPr[]): OpenPr | undefined {
  return openPrs.find((pr) => {
    const body = pr.body ?? "";
    return pr.headRefName === branch
      || body.includes(`#${issue.number}`)
      || body.includes(`/issues/${issue.number}`)
      || pr.title.includes(branch);
  });
}

function isEligible(issue: GitHubIssue): boolean {
  const skip = ["rechazada", "en-revision", "done"];
  return !skip.some((l) => issue.labels.includes(l));
}

function retryAttempt(labels: string[]): number {
  const label = labels.find((l) => l.startsWith(RETRY_LABEL_PREFIX));
  return label ? Number(label.slice(RETRY_LABEL_PREFIX.length)) || 0 : 0;
}

function retryDelayMs(attempt: number): number {
  const minutes = Math.min(60, 5 * 2 ** Math.max(0, attempt - 1));
  return minutes * 60_000;
}

function parseFailureRetryState(body: string): FailureRetryState | null {
  const match = body.match(FAILURE_MARKER_RE);
  if (!match) return null;

  const attempt = Number(match[1]);
  const retryAfter = new Date(match[2]);
  if (!Number.isFinite(attempt) || Number.isNaN(retryAfter.getTime())) return null;
  return { attempt, retryAfter };
}

async function latestFailureRetryState(issueNumber: number): Promise<FailureRetryState | null> {
  const { stdout } = await exec("gh", [
    "issue", "view", String(issueNumber),
    "-R", config.repo,
    "--json", "comments",
  ], { env: AGENT_ENV });
  const data = JSON.parse(stdout) as { comments: Array<{ body: string }> };

  for (const comment of [...data.comments].reverse()) {
    const retry = parseFailureRetryState(comment.body);
    if (retry) return retry;
  }
  return null;
}

async function retryReady(issue: GitHubIssue): Promise<boolean> {
  const attempts = retryAttempt(issue.labels);
  if (attempts >= config.maxAgentRetries) {
    console.log(`⛔ Issue #${issue.number}: máximo de reintentos alcanzado (${attempts}/${config.maxAgentRetries})`);
    return false;
  }

  if (!issue.labels.includes(FAILED_LABEL)) return true;

  const retry = await latestFailureRetryState(issue.number);
  if (!retry) return true;

  const now = Date.now();
  if (retry.retryAfter.getTime() > now) {
    console.log(`⏳ Issue #${issue.number}: retry pendiente hasta ${retry.retryAfter.toISOString()}`);
    return false;
  }

  return true;
}

function priorityScore(issue: GitHubIssue, allIssues: GitHubIssue[]): number {
  let score = 0;

  // Severidad por labels
  if (issue.labels.includes("critical")) score += 50;
  if (issue.labels.includes("high")) score += 30;
  if (issue.labels.includes("bug")) score += 20;
  if (issue.labels.includes("audit:security")) score += 40;

  // Impacto: más países/clientes afectados = más prioridad
  const countryLabels = issue.labels.filter((l) => l.startsWith("country:")).length;
  const customerLabels = issue.labels.filter((l) => l.startsWith("customer:")).length;
  score += countryLabels * 10 + customerLabels * 5;

  // Frecuencia: módulo con muchas issues abiertas = hotspot
  const moduleMatch = issue.title.match(/(?:en|in)\s+([\w-]+)/i);
  if (moduleMatch) {
    const module = moduleMatch[1].toLowerCase();
    const sameModule = allIssues.filter((i) => i.title.toLowerCase().includes(module)).length;
    score += Math.min(sameModule * 8, 30);
  }

  // Usamos longitud del body como proxy de complejidad inversa (menos complejo = resolver antes)
  const bodyLen = issue.body.length;
  if (bodyLen < 500) score += 10;
  else if (bodyLen > 2000) score -= 5;

  return score;
}

async function addLabel(issueNumber: number, label: string): Promise<void> {
  await exec("gh", [
    "issue", "edit", String(issueNumber),
    "--repo", config.repo,
    "--add-label", label,
  ], { env: AGENT_ENV });
}

async function removeLabel(issueNumber: number, label: string): Promise<void> {
  try {
    await exec("gh", [
      "issue", "edit", String(issueNumber),
      "--repo", config.repo,
      "--remove-label", label,
    ], { env: AGENT_ENV });
  } catch {}
}

async function ensureLabel(label: string, color = "BFD4F2"): Promise<void> {
  try {
    await exec("gh", ["label", "create", label, "-R", config.repo, "--color", color], { env: AGENT_ENV });
  } catch {}
}

async function setRetryAttempt(issueNumber: number, attempt: number): Promise<void> {
  for (let i = 0; i <= config.maxAgentRetries + 1; i++) {
    await removeLabel(issueNumber, `${RETRY_LABEL_PREFIX}${i}`);
  }

  const label = `${RETRY_LABEL_PREFIX}${attempt}`;
  await ensureLabel(label, "FBCA04");
  await addLabel(issueNumber, label);
}

function errorSummary(err: unknown): string {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  return message.length <= 2_000 ? message : `${message.slice(0, 2_000)}\n... (truncado)`;
}

function isQuotaFailure(err: unknown): boolean {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  const normalized = message.toLowerCase();
  return normalized.includes("out of credits")
    || normalized.includes("workspace owner to refill")
    || normalized.includes("account/time quota")
    || normalized.includes("usage limit")
    || normalized.includes("limits reset")
    || normalized.includes("rate limit")
    || normalized.includes("quota")
    || normalized.includes("credits");
}

async function recordFailure(issue: GitHubIssue, err: unknown): Promise<void> {
  const quotaFailure = isQuotaFailure(err);
  const currentAttempt = retryAttempt(issue.labels);
  const attempt = quotaFailure ? currentAttempt : currentAttempt + 1;
  const retryAfter = new Date(Date.now() + (quotaFailure ? QUOTA_RETRY_DELAY_MS : retryDelayMs(attempt)));
  const summary = errorSummary(err);

  await removeLabel(issue.number, config.processingLabel);
  await ensureLabel(FAILED_LABEL, "D93F0B");
  await addLabel(issue.number, FAILED_LABEL);

  if (quotaFailure) {
    for (let i = 0; i <= config.maxAgentRetries + 1; i += 1) {
      await removeLabel(issue.number, `${RETRY_LABEL_PREFIX}${i}`);
    }
  } else {
    await setRetryAttempt(issue.number, attempt);
  }

  const failureTitle = quotaFailure
    ? "Quota pause: Symphony Agent waiting for credits reset"
    : `Failure: Symphony Agent failed on attempt ${attempt}/${config.maxAgentRetries}.`;
  const retryMessage = quotaFailure
    ? `Automatic retry in 10 hours: ${retryAfter.toISOString()}`
    : `Automatic retry after: ${retryAfter.toISOString()}`;

  await exec("gh", [
    "issue", "comment", String(issue.number),
    "-R", config.repo,
    "--body", `<!-- symphony-agent-failure attempt=${attempt} retryAfter=${retryAfter.toISOString()} -->\n${failureTitle}\n\n${retryMessage}\n\n\`\`\`text\n${summary}\n\`\`\``,
  ], { env: AGENT_ENV, maxBuffer: 1024 * 1024 * 5 });

  if (!quotaFailure && attempt >= config.maxAgentRetries) {
    await notifyAgentFailureEmail(issue.number, issue.title, attempt, config.maxAgentRetries, summary);
  }
}

async function clearFailureState(issueNumber: number): Promise<void> {
  await removeLabel(issueNumber, config.processingLabel);
  await removeLabel(issueNumber, FAILED_LABEL);
  for (let i = 0; i <= config.maxAgentRetries + 1; i++) {
    await removeLabel(issueNumber, `${RETRY_LABEL_PREFIX}${i}`);
  }
}

async function reconcileStaleProcessingLabels(openPrs: OpenPr[]): Promise<void> {
  const processingIssues = await fetchOpenIssues(config.processingLabel);

  for (const issue of processingIssues) {
    if (running.has(issue.number)) continue;

    const branch = branchNameForIssue(issue.number, issue.title);
    const pr = findOpenPrForIssue(issue, branch, openPrs);
    await removeLabel(issue.number, config.processingLabel);

    if (pr && !issue.labels.includes("en-revision")) {
      await addLabel(issue.number, "en-revision");
      console.log(`🧹 Issue #${issue.number}: PR abierta detectada (${pr.url}); movida a en-revision`);
    } else {
      console.log(`🧹 Issue #${issue.number}: label ${config.processingLabel} huérfana eliminada`);
    }
  }
}

async function maybeCleanupMergedMutationBranches(): Promise<void> {
  const now = Date.now();
  if (now - lastBranchCleanupAt < BRANCH_CLEANUP_INTERVAL_MS) return;
  lastBranchCleanupAt = now;

  try {
    const { stdout } = await exec("gh", [
      "pr", "list",
      "-R", config.repo,
      "--state", "merged",
      "--json", "number,headRefName,url",
      "--limit", "100",
    ], { env: AGENT_ENV });
    const prs = JSON.parse(stdout) as Array<{ number: number; headRefName: string; url: string }>;
    const branches = [...new Set(prs.map((pr) => pr.headRefName).filter((branch) => branch.startsWith("internal/mutation-")))];

    for (const branch of branches) {
      try {
        await exec("git", ["push", "origin", "--delete", branch], {
          cwd: resolve(config.frontendRepoDir),
          env: AGENT_ENV,
          maxBuffer: 1024 * 1024 * 5,
          timeout: 60_000,
        });
        console.log(`🧹 Rama remota eliminada: ${branch}`);
      } catch (err) {
        console.log(`🧹 Rama remota no eliminada (${branch}): ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn("⚠️  Limpieza de ramas mutation falló:", err);
  }
}

async function collectEligibleIssues(issues: GitHubIssue[], openPrs: OpenPr[]): Promise<GitHubIssue[]> {
  const eligible: GitHubIssue[] = [];

  for (const issue of issues) {
    if (!isEligible(issue) || running.has(issue.number) || issue.labels.includes(config.processingLabel)) continue;

    const branch = branchNameForIssue(issue.number, issue.title);
    const pr = findOpenPrForIssue(issue, branch, openPrs);
    if (pr) {
      console.log(`⏭️  Issue #${issue.number}: ya tiene PR abierta (${pr.url})`);
      if (!issue.labels.includes("en-revision")) await addLabel(issue.number, "en-revision");
      await removeLabel(issue.number, config.processingLabel);
      continue;
    }

    if (!(await retryReady(issue))) continue;
    eligible.push(issue);
  }

  return eligible;
}

function selectIssueBatch(eligible: GitHubIssue[], allIssues: GitHubIssue[]): ScoredIssue[] {
  const slots = config.maxConcurrentAgents - running.size;
  return eligible
    .map((issue) => ({ issue, score: priorityScore(issue, allIssues) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, slots));
}

async function previousFailureContext(issueNumber: number, attempt: number): Promise<string> {
  if (attempt <= 0) return "";

  const prevFailure = await latestFailureRetryState(issueNumber);
  if (!prevFailure) return "";

  const { stdout: comments } = await exec("gh", [
    "issue", "view", String(issueNumber),
    "-R", config.repo,
    "--json", "comments",
  ], { env: AGENT_ENV });
  const data = JSON.parse(comments) as { comments: Array<{ body: string }> };
  const lastFailComment = [...data.comments].reverse().find((comment) => comment.body.includes("symphony-agent-failure"));
  const errorBlock = lastFailComment?.body.match(/```text\n([\s\S]*?)```/);
  return errorBlock ? errorBlock[1].trim() : "";
}

async function buildLaunchPlan(scored: ScoredIssue): Promise<AgentLaunchPlan> {
  const attempt = retryAttempt(scored.issue.labels);
  const routerDecision = routeIssue({
    number: scored.issue.number,
    title: scored.issue.title,
    body: scored.issue.body,
    labels: scored.issue.labels,
    attempt,
    maxKiroAttemptsBeforeCodex: config.maxKiroAttemptsBeforeCodex,
  });

  return {
    ...scored,
    baseBranch: routerDecision.baseBranch,
    forceCodex: routerDecision.solverPreference === "codex",
    previousFailureContext: await previousFailureContext(scored.issue.number, attempt),
    routerDecision,
  };
}

function launchAgent(plan: AgentLaunchPlan): void {
  const { issue, score, baseBranch, forceCodex, previousFailureContext, routerDecision } = plan;

  running.add(issue.number);
  console.log(`🚀 Lanzando agente para #${issue.number}: ${issue.title} (prioridad: ${score}; router: ${routerDecision.complexity}/${routerDecision.solverPreference}; dominio: ${routerDecision.primaryDomain})`);

  addLabel(issue.number, config.processingLabel).catch(() => {});

  runAgent(issue.number, issue.title, issue.body, baseBranch, forceCodex, previousFailureContext, formatRouterDecision(routerDecision))
    .then(async () => {
      await clearFailureState(issue.number);
      console.log(`✅ Agente terminó #${issue.number}`);
    })
    .catch(async (err) => {
      console.error(`❌ Agente falló #${issue.number}:`, err);
      await recordFailure(issue, err).catch((recordErr) => {
        console.error(`❌ No se pudo registrar el fallo de #${issue.number}:`, recordErr);
      });
    })
    .finally(() => {
      running.delete(issue.number);
    });
}

export function getRunningIssues(): number[] {
  return [...running];
}

export async function solveIssues(): Promise<void> {
  await maybeCleanupMergedMutationBranches();

  const openPrs = await fetchOpenPullRequests();
  await reconcileStaleProcessingLabels(openPrs);

  const issues = await fetchOpenIssues();
  const eligible = await collectEligibleIssues(issues, openPrs);

  if (eligible.length === 0) {
    console.log("💤 No hay issues pendientes");
    return;
  }

  for (const scored of selectIssueBatch(eligible, issues)) {
    launchAgent(await buildLaunchPlan(scored));
  }
}
