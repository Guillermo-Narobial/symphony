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
  rejectAssignee: env("REJECT_ASSIGNEE", "Guillermo-Narobial"),

  // Repos
  reposDir: env("REPOS_DIR", "./repos"),
  repos: [
    "https://github.com/Narobial/Narobial-Frontend",
    "https://github.com/Narobial/narobial-changelog",
    "https://github.com/Narobial/narobialAdmin-Frontend",
    "https://github.com/Narobial/narobial-docs",
  ],

  // Solver
  frontendRepoDir: env("FRONTEND_REPO_DIR", "./repos/Narobial-Frontend"),
  agentWorkspacesDir: env("AGENT_WORKSPACES_DIR", "./repos"),
  maxConcurrentAgents: Number(env("MAX_CONCURRENT_AGENTS", "3")),
  maxAgentRetries: Number(env("MAX_AGENT_RETRIES", "3")),
  solverCommand: env("SOLVER_COMMAND", "kiro"),
  processingLabel: env("PROCESSING_LABEL", "agente-trabajando"),

  // Deploy qdevweb
  deployHost: env("DEPLOY_HOST", "qdevweb.intraquiter"),
  deploySshKey: env("DEPLOY_SSH_KEY", "~/.ssh/id_ed25519"),
  deployBuildCmd: env("DEPLOY_BUILD_CMD", "build-hotfix"),
};
