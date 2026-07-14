import { agentManifest } from "./agent-manifest.js";

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

export const config = {
  // DMS API
  dmsUrl: env("DMS_URL"),
  dmsAccessToken: env("DMS_ACCESS_TOKEN"),
  dmsClientId: env("DMS_CLIENT_ID"),
  dmsMetodoDms: env("DMS_METODO", "GET.Q700"),
  dmsEntidad: env("DMS_ENTIDAD", "CATALOGO"),
  dmsMethodType: env("DMS_METHOD_TYPE", "GET"),
  dmsServerCode: env("DMS_SERVER_CODE", "1297"),
  dmsHeaders: env("DMS_HEADERS", '{"headers":{"idp":"AGENT-NABORIAL","profile":"App_qservers"}}'),
  dmsCustomInterface: env("DMS_CUSTOM_INTERFACE", '{"interfaces":["id","analystDeveloperId","assignedDate","brandId","closingDate","countryId","creationDate","creationHour","creationUser","customerId","customerRequirements","groupId","isClosed","isNarobial","isOpened","isProject","isQ700","isQuiter","isSuggestion","projectManagerId","requirements","statusId","title","typeId","uploadDate","userCode","narobialAppVersion","estimatedDevelopmentEndDate","developmentEndDate","developmentStartDate","pilotDate","resources.resourceId","resources.startDate","resources.endDate"]}'),
  dmsSearchValue: env("DMS_SEARCH_VALUE", "gcalleja"),  // overridable via --user CLI arg
  dmsIsOpened: env("DMS_IS_OPENED", "true"),

  // GitHub
  repo: env("GITHUB_REPO"),
  rejectAssignee: env("REJECT_ASSIGNEE", agentManifest.github.rejectAssignee),

  // Repos
  reposDir: env("REPOS_DIR", agentManifest.repos.directory),
  repos: agentManifest.repos.urls,

  // Solver
  frontendRepoDir: env("FRONTEND_REPO_DIR", agentManifest.repos.frontendDirectory),
  agentWorkspacesDir: env("AGENT_WORKSPACES_DIR", agentManifest.repos.directory),
  maxConcurrentAgents: Number(env("MAX_CONCURRENT_AGENTS", String(agentManifest.agent.maxConcurrentAgents))),
  maxAgentRetries: Number(env("MAX_AGENT_RETRIES", String(agentManifest.agent.maxAgentRetries))),
  maxKiroAttemptsBeforeCodex: Number(env("MAX_KIRO_ATTEMPTS_BEFORE_CODEX", String(agentManifest.agent.maxKiroAttemptsBeforeCodex))),
  solverCommand: env("SOLVER_COMMAND", agentManifest.solver.command),
  processingLabel: env("PROCESSING_LABEL", agentManifest.agent.processingLabel),

  // Deploy qdevweb
  deployHost: env("DEPLOY_HOST", agentManifest.deploy.host),
  deploySshKey: env("DEPLOY_SSH_KEY", agentManifest.deploy.sshKey),
  deployBuildCmd: env("DEPLOY_BUILD_CMD", agentManifest.deploy.buildCmd),
};
