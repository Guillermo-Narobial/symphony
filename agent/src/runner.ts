import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AGENT_ENV, runAgentWithFallback } from "./agent-executor.js";
import { config } from "./config.js";
import { linkBranch, updateIssueStatus } from "./issuer.js";
import { buildInstructionContext } from "./instruction-context.js";
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

async function resetWorkspaceToBranch(workDir: string, branch: string): Promise<void> {
  await git(workDir, "fetch", "origin", "--prune");
  await git(workDir, "reset", "--hard");
  await git(workDir, "clean", "-fd");
  try {
    await git(workDir, "checkout", branch);
  } catch {
    await git(workDir, "checkout", "-b", branch, `origin/${branch}`);
  }
  await git(workDir, "pull", "origin", branch, "--ff-only");
}

export async function prepareIssueWorkspace(issueNumber: number, baseBranch: string): Promise<string> {
  const workDir = await ensureIssueWorkspace(issueNumber);
  await resetWorkspaceToBranch(workDir, baseBranch);
  return workDir;
}

export async function prepareExistingBranchWorkspace(issueNumber: number, branch: string): Promise<string> {
  const workDir = await ensureIssueWorkspace(issueNumber);
  await resetWorkspaceToBranch(workDir, branch);
  return workDir;
}

function buildPrompt(issueNumber: number, title: string, body: string, branch: string, baseBranch: string, kbContext: string, instructionContext: string, routerContext: string): string {
  return `# Orden de trabajo — Issue #${issueNumber}

## Contexto

Estás en el repositorio Narobial-Frontend, rama \`${branch}\`, creada desde \`${baseBranch}\`.
Tu objetivo es resolver la issue #${issueNumber} del repo ${config.repo}.

${kbContext}

${instructionContext}

${routerContext}

## Issue

**Título:** ${title}

**Contenido completo:**

${body}

## Instrucciones de ejecución

### 1. Preparación (OBLIGATORIO)

- Lee primero los documentos listados en "Contexto de instrucciones dirigido". No cargues \`INSTRUCTIONS.md\` completo salvo que necesites una seccion concreta no cubierta por ese contexto.
- **Consulta el historial de decisiones antes de implementar:**
  \`\`\`bash
  curl -s "http://localhost:4040/api/decisions?q=$(echo '${title}' | tr ' ' '+')" | head -80
  \`\`\`
  Esto te dará resoluciones anteriores similares. Si hay coincidencias relevantes, úsalas como referencia para no repetir errores ni reinventar soluciones.
- Ejecuta \`npm run test:unit:profile\` para detectar el perfil de testing activo.
- Identifica los flujos, componentes y servicios afectados por esta issue.
- **Si la issue menciona que algo funcionaba en una versión anterior (ej: "en v6.5.4 funcionaba"):**
  1. Identifica los tags de versión con \`git tag | grep <version>\`
  2. Haz \`git diff <tag_buena> <tag_mala> -- <archivos_afectados>\` para ver qué cambió
  3. Analiza el diff antes de proponer un fix — la solución suele ser revertir o ajustar el cambio que introdujo la regresión

### 2. Implementación

- Implementa la solución siguiendo estrictamente los requisitos de la issue.
- Respeta las convenciones del proyecto: design system \`nb-\`, traducciones con \`| translate\`, CSS variables.
- Si tocas textos visibles al usuario, añade las claves en \`es.json\` con el valor en español y ejecuta \`npm run i18n:sync\`. El sync propaga automáticamente a idiomas latinos (ar, cl, co, mx, mx-to, pe) copiando el español. Para en.json y fr.json las claves nuevas DEBEN quedar como \`"[TODO] valor en español"\` — el sync lo hace solo, NO traduzcas manualmente a esos dos idiomas. El resto (pt.json, cat.json) sí se traducen automáticamente.
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

## Protocolo ante limite de Codex

- Si Codex falla por limite global de cuenta/tiempo (\`You've hit your usage limit\`, \`try again at <hora>\`, \`limits reset\`, \`rate limit\`, \`quota\`, \`credits\`), no reintentes en bucle: conserva el workspace y reporta la hora de reset si aparece.
- Si Codex falla por limite de pestana/sesion/conversacion/contexto (\`session limit\`, \`tab limit\`, \`conversation limit\`, \`context window\`, \`maximum context\`, \`start a new session\`), crea \`CODEX_HANDOFF.md\` con objetivo, issue/rama, estado git, trabajo completado, archivos tocados, tests, bloqueos, pendientes y prompt de continuacion; termina la sesion actual para que otra sesion de Codex retome desde ese archivo.
- No hagas \`git reset\`, no descartes cambios y no reinicies la tarea al cambiar de sesion.

## Restricciones

- NO inventes nombres de componentes, rutas o endpoints que no existan en el código.
- NO hagas cambios fuera del alcance de la issue.
- Si algo no está claro o no puedes resolverlo, PARA y documenta la incertidumbre.
- Si los tests no pasan, arregla el problema antes de hacer push.
`;
}

function buildSelfCritiqueBlock(previousFailureContext: string): string {
  if (!previousFailureContext) return "";

  return `\n\n## ⚠️ Autocrítica — Intento anterior falló\n\nEl agente anterior intentó resolver esta issue y falló. Analiza su error antes de empezar y NO repitas el mismo enfoque:\n\n\`\`\`text\n${previousFailureContext.slice(0, 3000)}\n\`\`\`\n\nSé autocrítico: identifica qué hizo mal, por qué falló, y usa un enfoque diferente.\n`;
}

async function buildAgentPrompt(
  issueNumber: number,
  title: string,
  body: string,
  branch: string,
  baseBranch: string,
  previousFailureContext: string,
  routerContext: string,
): Promise<string> {
  const kbContext = await searchKnowledgeBase(title, body);
  const instructionContext = buildInstructionContext(title, body);
  return buildPrompt(issueNumber, title, body, branch, baseBranch, kbContext, instructionContext, routerContext)
    + buildSelfCritiqueBlock(previousFailureContext);
}

async function hasCommitsSince(workDir: string, baseBranch: string): Promise<boolean> {
  return (await git(workDir, "log", "--oneline", `${baseBranch}..HEAD`)).length > 0;
}

async function prepareAgentRun(issueNumber: number, branch: string, baseBranch: string): Promise<string> {
  const workDir = await prepareIssueWorkspace(issueNumber, baseBranch);
  await installDependencies(workDir);
  await git(workDir, "checkout", "-B", branch);
  await linkBranch(issueNumber, branch);
  await updateIssueStatus(issueNumber, "en-desarrollo");
  return workDir;
}

export async function runAgent(
  issueNumber: number,
  title: string,
  body: string,
  baseBranch: string,
  forceCodex = false,
  previousFailureContext = "",
  routerContext = "",
  labels: string[] = [],
): Promise<void> {
  const branch = branchNameForIssue(issueNumber, title);
  const workDir = await prepareAgentRun(issueNumber, branch, baseBranch);
  const finalPrompt = await buildAgentPrompt(issueNumber, title, body, branch, baseBranch, previousFailureContext, routerContext);

  const result = await runAgentWithFallback(finalPrompt, workDir, {
    forceCodex: config.solverCommand === "codex" || forceCodex,
  });
  console.log(`✅ Solver finalizado con ${result.solver}${result.usedFallback ? " (fallback)" : ""}`);

  if (!(await hasCommitsSince(workDir, baseBranch))) {
    throw new Error("El solver terminó sin generar commits");
  }

  await updateIssueStatus(issueNumber, "desarrollado");
  const port = await deployIfAllowed(branch, workDir, labels);

  if (port) {
    const deployUrl = `https://${config.deployHost}:${port}`;
    await addDeployUrlToPr(branch, deployUrl);
  }
}

function sshOptions(): string[] {
  return ["-i", config.deploySshKey, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=30"];
}

function deployContainerName(branch: string): string {
  return `nf-${branch.replace(/\//g, "-")}`.toLowerCase();
}

async function buildFrontend(workDir: string): Promise<void> {
  console.log(`🔨 Build local: npm run ${config.deployBuildCmd}...`);
  await exec("npm", ["run", config.deployBuildCmd], {
    cwd: workDir,
    env: AGENT_ENV,
    maxBuffer: 1024 * 1024 * 100,
    timeout: 300_000,
  });
}

async function packageFrontend(workDir: string): Promise<string> {
  console.log("📦 Empaquetando build...");
  const tarFile = "/tmp/agent-deploy.tar.gz";
  await exec("tar", ["czf", tarFile, "dist/narobial", "etc/default.conf", "etc/nginx.crt", "etc/nginx.key"], {
    cwd: workDir,
    env: AGENT_ENV,
  });
  return tarFile;
}

async function uploadPackage(tarFile: string, sshOpts: string[], remote: string): Promise<void> {
  console.log(`📤 Subiendo a ${config.deployHost}...`);
  await exec("scp", [...sshOpts, tarFile, `${remote}:/tmp/agent-deploy.tar.gz`], { env: AGENT_ENV });
}

function remoteDeployScript(containerName: string): string {
  return `
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
}

async function runRemoteDeploy(sshOpts: string[], remote: string, containerName: string): Promise<string | null> {
  console.log(`🐳 Docker build + run (${containerName})...`);
  const { stdout } = await exec("ssh", [...sshOpts, remote, remoteDeployScript(containerName)], {
    env: AGENT_ENV,
    maxBuffer: 1024 * 1024 * 10,
    timeout: 300_000,
  });
  return stdout.trim().split("\n").pop()?.trim() || null;
}

async function deployIfAllowed(branch: string, workDir: string, labels: string[]): Promise<string | null> {
  const approved = labels.some((label) => label.toLowerCase() === "deploy:approved");
  const blockedLabels = new Set(["security", "critical", "database", "deployment", "permissions"]);
  if (!approved && labels.some((label) => blockedLabels.has(label.toLowerCase()))) {
    console.log("⛔ Deploy automático bloqueado por etiqueta que requiere aprobación humana");
    return null;
  }
  const { stdout } = await exec("git", ["diff", "--name-only", "origin/hotfix-master...HEAD"], { cwd: workDir, env: AGENT_ENV });
  const sensitive = stdout.split("\n").filter(Boolean).find((file) => /(^|\/)(infra|infrastructure|deploy|docker|k8s|helm|terraform|migrations?|auth|authentication|permissions?)(\/|$)|(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$|^\.github\/workflows\//i.test(file));
  if (sensitive && !approved) { console.log(`⛔ Deploy automático bloqueado por cambio sensible: ${sensitive}`); return null; }
  if (approved) console.log("✅ Deploy sensible autorizado mediante deploy:approved");
  try {
    await exec("npm", ["run", "test:unit:staged"], { cwd: workDir, env: AGENT_ENV, timeout: 300_000, maxBuffer: 1024 * 1024 * 100 });
    await exec("npm", ["run", "test:unit:branch:coverage"], { cwd: workDir, env: AGENT_ENV, timeout: 300_000, maxBuffer: 1024 * 1024 * 100 });
  } catch (error) { console.log(`⛔ Deploy automático bloqueado: pruebas no verdes (${(error as Error).message})`); return null; }
  return deployToQdevweb(branch, workDir);
}

async function deployToQdevweb(branch: string, workDir: string): Promise<string | null> {
  const sshOpts = sshOptions();
  const remote = `root@${config.deployHost}`;
  const containerName = deployContainerName(branch);

  await buildFrontend(workDir);
  const tarFile = await packageFrontend(workDir);
  await uploadPackage(tarFile, sshOpts, remote);
  const port = await runRemoteDeploy(sshOpts, remote, containerName);

  if (port) {
    console.log(`✅ Deploy completado: https://${config.deployHost}:${port}`);
  }
  return port;
}

export async function addDeployUrlToPr(branch: string, deployUrl: string): Promise<void> {
  const [owner] = config.repo.split("/");
  const head = encodeURIComponent(`${owner}:${branch}`);
  const { stdout } = await exec("gh", [
    "api",
    `repos/${config.repo}/pulls?head=${head}&state=open&per_page=1`,
  ], { env: AGENT_ENV });
  const prs = JSON.parse(stdout) as Array<{ number: number; body: string | null }>;
  if (!prs.length) {
    throw new Error(`No se encontró una PR abierta para la rama ${branch}`);
  }

  const pr = prs[0];
  const currentBody = pr.body ?? "";
  const deploySection = `\n\n## 🚀 Deploy de prueba\n\n🔗 ${deployUrl}`;

  if (currentBody.includes(deployUrl)) return;

  const newBody = currentBody.replace(/\n\n## 🚀 Deploy de prueba\n\n🔗 .+/, "") + deploySection;
  await exec("gh", [
    "api",
    "-X", "PATCH",
    `repos/${config.repo}/pulls/${pr.number}`,
    "-f", `body=${newBody}`,
  ], { env: AGENT_ENV });
  console.log(`📝 PR #${pr.number} actualizada con URL de deploy: ${deployUrl}`);
}
