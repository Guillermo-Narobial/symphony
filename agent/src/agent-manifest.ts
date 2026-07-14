import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Scalar = string | number | boolean;
type ManifestValue = Scalar | string[] | ManifestObject;
interface ManifestObject {
  [key: string]: ManifestValue;
}

export interface AgentManifest {
  agent: {
    maxConcurrentAgents: number;
    maxAgentRetries: number;
    maxKiroAttemptsBeforeCodex: number;
    processingLabel: string;
  };
  solver: {
    command: string;
  };
  repos: {
    directory: string;
    frontendDirectory: string;
    urls: string[];
  };
  deploy: {
    host: string;
    sshKey: string;
    buildCmd: string;
  };
  github: {
    rejectAssignee: string;
  };
}

const DEFAULT_MANIFEST: AgentManifest = {
  agent: {
    maxConcurrentAgents: 3,
    maxAgentRetries: 10,
    maxKiroAttemptsBeforeCodex: 3,
    processingLabel: "agente-trabajando",
  },
  solver: {
    command: "kiro",
  },
  repos: {
    directory: "./repos",
    frontendDirectory: "./repos/Narobial-Frontend",
    urls: [
      "https://github.com/Narobial/Narobial-Frontend",
      "https://github.com/Narobial/narobial-changelog",
      "https://github.com/Narobial/narobialAdmin-Frontend",
      "https://github.com/Narobial/narobial-docs",
    ],
  },
  deploy: {
    host: "qdevweb.intraquiter",
    sshKey: "~/.ssh/id_ed25519",
    buildCmd: "build-hotfix",
  },
  github: {
    rejectAssignee: "Guillermo-Narobial",
  },
};

function parseScalar(value: string): Scalar {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const numeric = Number(trimmed);
  return trimmed !== "" && Number.isFinite(numeric) ? numeric : trimmed;
}

function parseSimpleYaml(content: string): ManifestObject {
  const root: ManifestObject = {};
  let section: Record<string, ManifestValue> | null = null;
  let listKey = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const sectionMatch = line.match(/^([A-Za-z_][\w-]*):$/);
    if (sectionMatch) {
      section = {};
      root[sectionMatch[1]] = section;
      listKey = "";
      continue;
    }

    const keyValueMatch = line.match(/^  ([A-Za-z_][\w-]*):(.*)$/);
    if (section && keyValueMatch) {
      const [, key, rawValue] = keyValueMatch;
      const value = rawValue.trim();
      if (value === "") {
        section[key] = [];
        listKey = key;
      } else {
        section[key] = parseScalar(value);
        listKey = "";
      }
      continue;
    }

    const listItemMatch = line.match(/^    -\s+(.+)$/);
    if (section && listKey && listItemMatch) {
      const current = section[listKey];
      if (Array.isArray(current)) {
        current.push(String(parseScalar(listItemMatch[1])));
      }
    }
  }

  return root;
}

function section(source: ManifestObject, key: string): ManifestObject {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as ManifestObject : {};
}

function stringValue(source: ManifestObject, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === "string" ? value : fallback;
}

function numberValue(source: ManifestObject, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === "number" ? value : fallback;
}

function stringArrayValue(source: ManifestObject, key: string, fallback: string[]): string[] {
  const value = source[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

function normalizeManifest(raw: ManifestObject): AgentManifest {
  const agent = section(raw, "agent");
  const solver = section(raw, "solver");
  const repos = section(raw, "repos");
  const deploy = section(raw, "deploy");
  const github = section(raw, "github");

  return {
    agent: {
      maxConcurrentAgents: numberValue(agent, "max_concurrent_agents", DEFAULT_MANIFEST.agent.maxConcurrentAgents),
      maxAgentRetries: numberValue(agent, "max_agent_retries", DEFAULT_MANIFEST.agent.maxAgentRetries),
      maxKiroAttemptsBeforeCodex: numberValue(agent, "max_kiro_attempts_before_codex", DEFAULT_MANIFEST.agent.maxKiroAttemptsBeforeCodex),
      processingLabel: stringValue(agent, "processing_label", DEFAULT_MANIFEST.agent.processingLabel),
    },
    solver: {
      command: stringValue(solver, "command", DEFAULT_MANIFEST.solver.command),
    },
    repos: {
      directory: stringValue(repos, "directory", DEFAULT_MANIFEST.repos.directory),
      frontendDirectory: stringValue(repos, "frontend_directory", DEFAULT_MANIFEST.repos.frontendDirectory),
      urls: stringArrayValue(repos, "urls", DEFAULT_MANIFEST.repos.urls),
    },
    deploy: {
      host: stringValue(deploy, "host", DEFAULT_MANIFEST.deploy.host),
      sshKey: stringValue(deploy, "ssh_key", DEFAULT_MANIFEST.deploy.sshKey),
      buildCmd: stringValue(deploy, "build_cmd", DEFAULT_MANIFEST.deploy.buildCmd),
    },
    github: {
      rejectAssignee: stringValue(github, "reject_assignee", DEFAULT_MANIFEST.github.rejectAssignee),
    },
  };
}

function loadAgentManifest(): AgentManifest {
  const manifestPath = resolve(process.env.AGENT_MANIFEST_PATH ?? "agent-manifest.yaml");
  if (!existsSync(manifestPath)) return DEFAULT_MANIFEST;
  return normalizeManifest(parseSimpleYaml(readFileSync(manifestPath, "utf-8")));
}

export const agentManifest = loadAgentManifest();
