import { routeInstructionContext } from "./instruction-context.js";

export type IssueComplexity = "simple" | "standard" | "complex";
export type SolverPreference = "kiro" | "codex";

export interface RouterInput {
  number: number;
  title: string;
  body: string;
  labels: string[];
  attempt: number;
  maxKiroAttemptsBeforeCodex?: number;
}

export interface RouterDecision {
  complexity: IssueComplexity;
  primaryDomain: string;
  domains: string[];
  contextDocs: string[];
  solverPreference: SolverPreference;
  baseBranch: string;
  reasons: string[];
}

const COMPLEXITY_MARKERS = [
  "arquitectura",
  "architecture",
  "refactor",
  "migracion",
  "migración",
  "migration",
  "multi modulo",
  "multi módulo",
  "seguridad",
  "security",
  "performance",
  "rendimiento",
];

function includesAny(text: string, markers: string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

function complexityFromScore(score: number): IssueComplexity {
  if (score <= 1) return "simple";
  if (score <= 3) return "standard";
  return "complex";
}

function routeBaseBranch(input: RouterInput): string {
  if (input.labels.includes("audit:weak-test")) return "release";
  return "hotfix-master";
}

function scoreIssue(input: RouterInput, domainCount: number): { score: number; reasons: string[] } {
  const text = `${input.title}\n${input.body}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (input.body.length < 500) {
    reasons.push("body corto");
  } else if (input.body.length > 2_500) {
    score += 2;
    reasons.push("body largo");
  } else if (input.body.length > 1_200) {
    score += 1;
    reasons.push("body medio");
  }

  if (input.labels.some((label) => ["critical", "high", "audit:security"].includes(label))) {
    score += 2;
    reasons.push("label de severidad alta");
  }

  if (domainCount > 1) {
    score += 1;
    reasons.push("afecta varios dominios");
  }

  if (includesAny(text, COMPLEXITY_MARKERS)) {
    score += 2;
    reasons.push("marcadores de complejidad en texto");
  }

  if (input.attempt > 0) {
    score += Math.min(input.attempt, 3);
    reasons.push(`reintento ${input.attempt}`);
  }

  return { score, reasons };
}

function solverPreference(complexity: IssueComplexity, attempt: number, maxKiroAttemptsBeforeCodex: number): SolverPreference {
  if (complexity === "complex") return "codex";
  if (attempt >= maxKiroAttemptsBeforeCodex) return "codex";
  return "kiro";
}

export function routeIssue(input: RouterInput): RouterDecision {
  const instructionRoute = routeInstructionContext(input.title, input.body);
  const domains = instructionRoute.domains.map((domain) => domain.name);
  const contextDocs = instructionRoute.domains.map((domain) => domain.doc);
  const { score, reasons } = scoreIssue(input, domains.length);
  const complexity = complexityFromScore(score);
  const preferredSolver = solverPreference(complexity, input.attempt, input.maxKiroAttemptsBeforeCodex ?? 3);

  if (domains.length === 0) reasons.push("sin dominio especializado detectado");
  if (preferredSolver === "codex") reasons.push("requiere solver fuerte o supero umbral de retries");
  else reasons.push("apto para ruta ligera inicial");

  return {
    complexity,
    primaryDomain: domains[0] ?? "Narobial Frontend principal",
    domains,
    contextDocs,
    solverPreference: preferredSolver,
    baseBranch: routeBaseBranch(input),
    reasons,
  };
}

export function formatRouterDecision(decision: RouterDecision): string {
  const docs = decision.contextDocs.length > 0 ? decision.contextDocs.map((doc) => `- \`${doc}\``).join("\n") : "- Sin ficha especializada inicial";
  return `## Decisión del LLM Router

- Complejidad: ${decision.complexity}
- Dominio líder: ${decision.primaryDomain}
- Dominios: ${decision.domains.length > 0 ? decision.domains.join(", ") : "ninguno especializado"}
- Solver preferido: ${decision.solverPreference}
- Rama base: ${decision.baseBranch}
- Razones: ${decision.reasons.join("; ")}

### Contexto recomendado por router

${docs}
`;
}
