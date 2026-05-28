import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AGENT_ENV, runAgentWithFallback } from "./agent-executor.js";
import { config } from "./config.js";
import { linkBranch, updateIssueStatus } from "./issuer.js";
import { searchKnowledgeBase } from "./knowledge-base.js";

const exec = promisify(execFile);

const FRONTEND_REPO_URL =
  config.repos.find((url) => url.includes("Narobial-Frontend"))
  ?? "https://github.com/Narobial/Narobial-Frontend";

export function branchNameForIssue(_issueNumber: number, title: string): string {
  // Issues de mutation testing -> internal/
  if (title.startsWith("[mutation]")) {
    const slug = title
      .replace(/^\[mutation\]\s*/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    return `internal/mutation-${_issueNumber}-${slug}`;
  }
  // Extraer ID de ticket (P05942026ES o Q1234-2026-ES) del título
  const ticketMatch = title.match(/^([PQ])(\d{4})(\d{4})([A-Z]{2})/i);
  if (ticketMatch) {
    const [, , code, year, country] = ticketMatch;
    return `hotfix/${code}-${year}-${country.toUpperCase()}`;
  }
  // Fallback para incidencias normales (título tipo "1448-2026-ES: ...")
  const incMatch = title.match(/^(\d+-\d{4}-[A-Z]{2})/i);
  if (incMatch) {
    return `hotfix/${incMatch[1].toUpperCase()}`;
  }
  // Último fallback: slug del título
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `hotfix/${slug}`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: AGENT_ENV });
  return stdout.trim();
}

export function issueWorkspaceDir(issueNumber: number): string {
  return resolve(config.agentWorkspacesDir, `workspace-${issueNumber}`);
}

async function ensureIssueWorkspace(issueNumber: number): Promise<string> {
  const workDir = issueWorkspaceDir(issueNumber);
  const gitDir = join(workDir, ".git");

  if (existsSync(gitDir)) return workDir;
  if (existsSync(workDir)) {
    throw new Error(`Workspace exists but is not a git repository: ${workDir}`);
  }

  mkdirSync(resolve(config.agentWorkspacesDir), { recursive: true });
  await exec("git", ["clone", FRONTEND_REPO_URL, workDir], {
    env: AGENT_ENV,
    maxBuffer: 1024 * 1024 * 20,
    timeout: 300_000,
  });
  return workDir;
}

export async function installDependencies(workDir: string): Promise<void> {
  await exec("npm", ["ci", "--ignore-scripts"], {
    cwd: workDir,
    env: AGENT_ENV,
    maxBuffer: 1024 * 1024 * 50,
    timeout: 300_000,
  });
}

export async function prepareIssueWorkspace(issueNumber: number, baseBranch: string): Promise<string> {
  const workDir = await ensureIssueWorkspace(issueNumber);

  await git(workDir, "fetch", "origin", "--prune");
  await git(workDir, "reset", "--hard");
  await git(workDir, "clean", "-fd");
  try {
    await git(workDir, "checkout", baseBranch);
  } catch {
    await git(workDir, "checkout", "-b", baseBranch, `origin/${baseBranch}`);
  }
  await git(workDir, "pull", "origin", baseBranch, "--ff-only");

  return workDir;
}

export async function prepareExistingBranchWorkspace(issueNumber: number, branch: string): Promise<string> {
  const workDir = await ensureIssueWorkspace(issueNumber);

  await git(workDir, "fetch", "origin", "--prune");
  await git(workDir, "reset", "--hard");
  await git(workDir, "clean", "-fd");
  try {
    await git(workDir, "checkout", branch);
  } catch {
    await git(workDir, "checkout", "-b", branch, `origin/${branch}`);
  }
  await git(workDir, "pull", "origin", branch, "--ff-only");

  return workDir;
}

function buildPrompt(issueNumber: number, title: string, body: string, branch: string, baseBranch: string, kbContext: string): string {
  return `# Orden de trabajo — Issue #${issueNumber}

## Contexto

Estás en el repositorio Narobial-Frontend, rama \`${branch}\`, creada desde \`${baseBranch}\`.
Tu objetivo es resolver la issue #${issueNumber} del repo ${config.repo}.

${kbContext}

## Issue

**Título:** ${title}

**Contenido completo:**

${body}

## Instrucciones de ejecución

### 1. Preparación (OBLIGATORIO)

- Lee \`AGENTS.md\` e \`INSTRUCTIONS.md\` del proyecto para conocer todas las reglas.
- Ejecuta \`npm run test:unit:profile\` para detectar el perfil de testing activo.
- Identifica los flujos, componentes y servicios afectados por esta issue.
- **Si la issue menciona que algo funcionaba en una versión anterior (ej: "en v6.5.4 funcionaba"):**
  1. Identifica los tags de versión con \`git tag | grep <version>\`
  2. Haz \`git diff <tag_buena> <tag_mala> -- <archivos_afectados>\` para ver qué cambió
  3. Analiza el diff antes de proponer un fix — la solución suele ser revertir o ajustar el cambio que introdujo la regresión

### 2. Implementación

- Implementa la solución siguiendo estrictamente los requisitos de la issue.
- Respeta las convenciones del proyecto: design system \`nb-\`, traducciones con \`| translate\`, CSS variables.
- Si tocas textos visibles al usuario, añade las claves en \`es.json\` y ejecuta \`npm run i18n:sync\`.
- Revisa seguridad: no concatenar entradas sin validar, no dejar edge cases sin cubrir.
- Cubre estados \`null\`, \`undefined\`, vacío, loading, error cuando apliquen.

### 3. Testing (OBLIGATORIO)

- Crea o actualiza los \`*.spec.ts\` relacionados con tu cambio.
- Ejecuta \`npm run test:unit:staged\` y verifica que pasan.
- Antes del push, ejecuta \`npm run test:unit:branch:coverage\`.

### 4. Commit y push

- Formato de commit: \`tipo(contexto): Descripción en español\`
- Tipos: fix, feat, docs, style, refactor, build.
- Haz push: \`git push -u origin ${branch}\`

### 5. Pull Request

- Crea la PR contra \`${baseBranch}\`:
  \`\`\`bash
  gh pr create --base ${baseBranch} --assignee ${config.rejectAssignee} --title "${branch}" --body "Resuelve #${issueNumber}"
  \`\`\`

### 6. Actualizar estado de la issue

\`\`\`bash
gh issue edit ${issueNumber} --repo ${config.repo} --add-label en-revision
\`\`\`

### 7. Registro en changelog (OBLIGATORIO después del push)

\`\`\`bash
cd narobial-changelog && git pull origin main
\`\`\`
- Añade entrada en CHANGELOG.md con formato: \`- [YYYY-MM-DD] TIPO ${branch} — Descripción corta | Frontend\`
- Crea archivo de decisión en \`decisiones/frontend/\`
- Commit y push del changelog.

## Restricciones

- NO inventes nombres de componentes, rutas o endpoints que no existan en el código.
- NO hagas cambios fuera del alcance de la issue.
- Si algo no está claro o no puedes resolverlo, PARA y documenta la incertidumbre.
- Si los tests no pasan, arregla el problema antes de hacer push.
`;
}

export async function runAgent(
  issueNumber: number,
  title: string,
  body: string,
  baseBranch: string,
): Promise<void> {
  const branch = branchNameForIssue(issueNumber, title);
  const workDir = await prepareIssueWorkspace(issueNumber, baseBranch);

  await installDependencies(workDir);
  await git(workDir, "checkout", "-B", branch);

  // Vincular rama a la issue (campo Development) y marcar en desarrollo
  await linkBranch(issueNumber, branch);
  await updateIssueStatus(issueNumber, "en-desarrollo");

  // Buscar resoluciones similares en el historial
  const kbContext = await searchKnowledgeBase(title, body);
  const prompt = buildPrompt(issueNumber, title, body, branch, baseBranch, kbContext);

  const result = await runAgentWithFallback(prompt, workDir, {
    forceCodex: config.solverCommand === "codex",
  });
  console.log(`✅ Solver finalizado con ${result.solver}${result.usedFallback ? " (fallback)" : ""}`);

  // Verificar si hay commits antes de deploy
  const hasCommits = (await git(workDir, "log", "--oneline", `${baseBranch}..HEAD`)).length > 0;
  if (!hasCommits) {
    throw new Error("El solver terminó sin generar commits");
  }

  // Deploy a qdevweb
  await updateIssueStatus(issueNumber, "desarrollado");
  const port = await deployToQdevweb(branch, workDir);

  // Actualizar PR con URL de deploy
  if (port) {
    const deployUrl = `https://${config.deployHost}:${port}`;
    await addDeployUrlToPr(branch, deployUrl);
  }
}

async function deployToQdevweb(branch: string, workDir: string): Promise<string | null> {
  const { deployHost, deploySshKey, deployBuildCmd } = config;
  const sshOpts = ["-i", deploySshKey, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=30"];
  const remote = `root@${deployHost}`;

  // 1. Build local
  console.log(`🔨 Build local: npm run ${deployBuildCmd}...`);
  await exec("npm", ["run", deployBuildCmd], { cwd: workDir, env: AGENT_ENV, maxBuffer: 1024 * 1024 * 100, timeout: 300_000 });

  // 2. Empaquetar dist + certs
  console.log("📦 Empaquetando build...");
  const tarFile = "/tmp/agent-deploy.tar.gz";
  await exec("tar", ["czf", tarFile, "dist/narobial", "etc/default.conf", "etc/nginx.crt", "etc/nginx.key"], { cwd: workDir, env: AGENT_ENV });

  // 3. Subir al servidor
  console.log(`📤 Subiendo a ${deployHost}...`);
  await exec("scp", [...sshOpts, tarFile, `${remote}:/tmp/agent-deploy.tar.gz`], { env: AGENT_ENV });

  // 4. Construir imagen y lanzar contenedor en remoto
  const containerName = `nf-${branch.replace(/\//g, "-")}`.toLowerCase();
  console.log(`🐳 Docker build + run (${containerName})...`);

  const remoteScript = `
set -e
DIR="/tmp/agent-build-$$"
mkdir -p "$DIR" && cd "$DIR"
tar xzf /tmp/agent-deploy.tar.gz
cat > Dockerfile <<'DEOF'
FROM nginx:1.29-alpine
COPY etc/nginx.crt /etc/nginx/ssl/nginx.crt
COPY etc/nginx.key /etc/nginx/ssl/nginx.key
COPY dist/narobial /usr/share/nginx/html
COPY etc/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 443
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget --no-verbose --tries=1 --spider https://localhost:443/ --no-check-certificate || exit 1
CMD ["nginx", "-g", "daemon off;"]
DEOF
docker build -t "${containerName}" . >/dev/null 2>&1
# Buscar puerto: reusar si ya existe, sino buscar libre desde 17000
EXISTING=$(docker ps --filter "name=^${containerName}$" --format '{{.Ports}}' 2>/dev/null | grep -oE '0\\.0\\.0\\.0:[0-9]+' | cut -d: -f2 || true)
if [ -n "$EXISTING" ]; then
  docker rm -f "${containerName}" >/dev/null 2>&1
  PORT="$EXISTING"
else
  PORT=17000
  while netstat -an | grep -q "0\\.0\\.0\\.0:$PORT"; do PORT=$((PORT + 1)); done
fi
docker run -d --name "${containerName}" -p "$PORT:443" --restart unless-stopped "${containerName}" >/dev/null 2>&1
rm -rf "$DIR" /tmp/agent-deploy.tar.gz
echo "$PORT"
`;

  const { stdout } = await exec("ssh", [...sshOpts, remote, remoteScript], {
    env: AGENT_ENV,
    maxBuffer: 1024 * 1024 * 10,
    timeout: 300_000,
  });

  const port = stdout.trim().split("\n").pop()?.trim() || null;
  if (port) {
    console.log(`✅ Deploy completado: https://${deployHost}:${port}`);
  }
  return port;
}

async function addDeployUrlToPr(branch: string, deployUrl: string): Promise<void> {
  try {
    const { stdout } = await exec("gh", [
      "pr", "list",
      "-R", config.repo,
      "--head", branch,
      "--json", "number,body",
      "--limit", "1",
    ], { env: AGENT_ENV });
    const prs = JSON.parse(stdout) as Array<{ number: number; body: string }>;
    if (!prs.length) return;

    const pr = prs[0];
    const deploySection = `\n\n## 🚀 Deploy de prueba\n\n🔗 ${deployUrl}`;

    // Solo añadir si no está ya
    if (pr.body.includes(deployUrl)) return;

    const newBody = pr.body.replace(/\n\n## 🚀 Deploy de prueba\n\n🔗 .+/, "") + deploySection;
    await exec("gh", ["pr", "edit", String(pr.number), "-R", config.repo, "--body", newBody], { env: AGENT_ENV });
    console.log(`📝 PR #${pr.number} actualizada con URL de deploy: ${deployUrl}`);
  } catch (err) {
    console.warn("⚠️  No se pudo actualizar la PR con la URL de deploy:", err);
  }
}
