import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { AGENT_ENV, runAgentWithFallback } from "./agent-executor.js";
import { config } from "./config.js";
import { branchNameForIssue, installDependencies, prepareExistingBranchWorkspace } from "./runner.js";

const exec = promisify(execFile);
const MAX_KIRO_ATTEMPTS = 3;
const ATTEMPT_LABEL_PREFIX = "review-attempt:";
const processing = new Set<number>();
const SCREENSHOTS_DIR = "/tmp/review-screenshots";

interface ReviewIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

interface Comment {
  author: string;
  body: string;
  createdAt: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: AGENT_ENV });
  return stdout.trim();
}

function extractImageUrls(text: string): string[] {
  const urls: string[] = [];
  // Markdown images: ![alt](url)
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) urls.push(m[1]);
  // HTML img tags: <img ... src="url" ...>
  for (const m of text.matchAll(/<img[^>]+src="([^"]+)"/g)) urls.push(m[1]);
  return urls;
}

async function downloadImages(comments: Comment[], issueNumber: number): Promise<string[]> {
  const allUrls = comments.flatMap((c) => extractImageUrls(c.body));
  if (allUrls.length === 0) return [];

  const dir = join(SCREENSHOTS_DIR, String(issueNumber));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const paths: string[] = [];
  for (let i = 0; i < allUrls.length; i++) {
    const ext = allUrls[i].match(/\.(png|jpg|jpeg|gif|webp)/i)?.[1] || "png";
    const filePath = join(dir, `screenshot-${i + 1}.${ext}`);
    try {
      const res = await fetch(allUrls[i]);
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        writeFileSync(filePath, buffer);
        paths.push(filePath);
      }
    } catch {}
  }
  return paths;
}

async function getIssuesEnRevision(): Promise<ReviewIssue[]> {
  const { stdout } = await exec("gh", [
    "issue", "list", "-R", config.repo,
    "--label", "en-revision",
    "--state", "open",
    "--json", "number,title,body,labels",
    "--limit", "20",
  ]);
  const raw = JSON.parse(stdout) as Array<{
    number: number; title: string; body: string; labels: Array<{ name: string }>;
  }>;
  return raw.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    labels: i.labels.map((l) => l.name),
  }));
}

async function getComments(issueNumber: number): Promise<Comment[]> {
  const { stdout } = await exec("gh", [
    "issue", "view", String(issueNumber),
    "-R", config.repo,
    "--json", "comments",
  ]);
  const data = JSON.parse(stdout) as { comments: Array<{ author: { login: string }; body: string; createdAt: string }> };
  return data.comments.map((c) => ({ author: c.author.login, body: c.body, createdAt: c.createdAt }));
}

function getAttemptCount(labels: string[]): number {
  const label = labels.find((l) => l.startsWith(ATTEMPT_LABEL_PREFIX));
  return label ? Number(label.split(":")[1]) || 0 : 0;
}

async function setAttemptCount(issueNumber: number, count: number): Promise<void> {
  // Remove old attempt labels
  for (let i = 0; i <= MAX_KIRO_ATTEMPTS + 1; i++) {
    try { await exec("gh", ["issue", "edit", String(issueNumber), "-R", config.repo, "--remove-label", `${ATTEMPT_LABEL_PREFIX}${i}`]); } catch {}
  }
  const label = `${ATTEMPT_LABEL_PREFIX}${count}`;
  try { await exec("gh", ["label", "create", label, "-R", config.repo, "--color", "FBCA04"]); } catch {}
  await exec("gh", ["issue", "edit", String(issueNumber), "-R", config.repo, "--add-label", label]);
}

function extractBranch(issueNumber: number, title: string): string | null {
  if (title.startsWith("[mutation]")) return branchNameForIssue(issueNumber, title);

  // Extraer rama del título de la issue (formato: "Q04092026MX: ..." o "1448-2026-ES: ...")
  const ticketMatch = title.match(/^([PQ])(\d{4})(\d{4})([A-Z]{2})/i);
  if (ticketMatch) {
    const [, , code, year, country] = ticketMatch;
    return `hotfix/${code}-${year}-${country.toUpperCase()}`;
  }
  const incMatch = title.match(/^(\d+-\d{4}-[A-Z]{2})/i);
  if (incMatch) return `hotfix/${incMatch[1].toUpperCase()}`;
  return null;
}

function buildCorrectionPrompt(issueNumber: number, title: string, body: string, comments: Comment[], branch: string, imagePaths: string[]): string {
  const commentBlock = comments.map((c) => `**@${c.author}** (${c.createdAt}):\n${c.body}`).join("\n\n---\n\n");

  const imageSection = imagePaths.length > 0
    ? `## Capturas adjuntas (ANALIZAR CON TOOL read mode Image)

Las siguientes imágenes fueron adjuntadas en los comentarios de revisión. Ábrelas y analízalas para entender el problema visual:

${imagePaths.map((p, i) => `- Captura ${i + 1}: \`${p}\``).join("\n")}

**IMPORTANTE:** Usa la herramienta de lectura de imágenes para ver cada captura antes de implementar la corrección.
`
    : "";

  return `# Corrección — Issue #${issueNumber}

## Contexto

Estás en el repositorio Narobial-Frontend, rama \`${branch}\`.
Ya existe una implementación previa que fue revisada y tiene feedback pendiente.
Tu objetivo es corregir los problemas señalados en los comentarios.

## Issue original

**Título:** ${title}

${body}

## Comentarios de revisión (LEER TODOS)

${commentBlock}

${imageSection}
## Instrucciones

### 1. Preparación (OBLIGATORIO)

- Lee \`AGENTS.md\` e \`INSTRUCTIONS.md\` del proyecto.
- Ejecuta \`npm run test:unit:profile\` para detectar el perfil de testing activo.
- Lee los comentarios de revisión arriba y entiende qué hay que corregir.
- Si hay capturas adjuntas, ábrelas con la herramienta de lectura de imágenes para entender el problema visual.
- **Si el feedback menciona que algo funcionaba en una versión anterior:**
  1. Identifica los tags con \`git tag | grep <version>\`
  2. Haz \`git diff <tag_buena> <tag_mala> -- <archivos_afectados>\`
  3. Analiza el diff para entender qué introdujo la regresión antes de corregir

### 2. Corrección

- Corrige TODOS los problemas señalados en los comentarios.
- No rehagas la implementación desde cero, solo corrige lo indicado.
- Respeta las convenciones del proyecto.

### 3. Testing (OBLIGATORIO)

- Ejecuta \`npm run test:unit:staged\` y verifica que pasan.
- Ejecuta \`npm run test:unit:branch:coverage\` antes del push.

### 4. Commit y push

- Formato: \`fix(contexto): Corrige feedback de revisión — #${issueNumber}\`
- Push: \`git push origin ${branch}\`

### 5. Comentar en la issue (OBLIGATORIO)

\`\`\`bash
gh issue comment ${issueNumber} --repo ${config.repo} --body "✅ Correcciones aplicadas según feedback. Listo para re-revisión."
\`\`\`

**NUNCA olvides este paso. Siempre hay que notificar en la issue después de pushear.**

## Restricciones

- NO hagas cambios fuera del alcance del feedback.
- Si los tests no pasan, arregla el problema antes de hacer push.
`;
}

async function runCorrectionAgent(issueNumber: number, branch: string, prompt: string, useCodex: boolean): Promise<string> {
  const workDir = await prepareExistingBranchWorkspace(issueNumber, branch);
  await installDependencies(workDir);

  const result = await runAgentWithFallback(prompt, workDir, { forceCodex: useCodex });
  console.log(`✅ Corrección ejecutada con ${result.solver}${result.usedFallback ? " (fallback)" : ""}`);
  return workDir;
}

async function hasNewFeedback(comments: Comment[], issueNumber: number, branch: string): Promise<boolean> {
  if (comments.length === 0) return false;
  // Check if last comment is NOT from the agent (bot)
  const last = comments[comments.length - 1];
  if (last.body.includes("✅ Correcciones aplicadas")) return false;
  // Check if there are comments after the last push
  const workDir = resolve(config.frontendRepoDir);
  try {
    await git(workDir, "fetch", "origin");
    const lastPush = await git(workDir, "log", "-1", "--format=%aI", `origin/${branch}`);
    return new Date(last.createdAt) > new Date(lastPush);
  } catch {
    return comments.length > 0;
  }
}

export async function reviewWatcher(): Promise<void> {
  const issues = await getIssuesEnRevision();
  if (issues.length === 0) {
    console.log("👀 No hay issues en revisión");
    return;
  }

  for (const issue of issues) {
    if (processing.has(issue.number)) {
      console.log(`⏳ Issue #${issue.number} ya está siendo corregida, saltando`);
      continue;
    }

    const branch = extractBranch(issue.number, issue.title);
    if (!branch) continue;

    const comments = await getComments(issue.number);
    const hasFeedback = await hasNewFeedback(comments, issue.number, branch);
    if (!hasFeedback) continue;

    const attempts = getAttemptCount(issue.labels) + 1;
    await setAttemptCount(issue.number, attempts);

    const useCodex = attempts > MAX_KIRO_ATTEMPTS;
    const agentName = useCodex ? "codex" : "kiro-cli";
    console.log(`🔄 Issue #${issue.number}: intento ${attempts} con ${agentName}`);

    processing.add(issue.number);
    const imagePaths = await downloadImages(comments, issue.number);
    if (imagePaths.length > 0) console.log(`📸 ${imagePaths.length} captura(s) descargadas para análisis`);
    const prompt = buildCorrectionPrompt(issue.number, issue.title, issue.body, comments, branch, imagePaths);
    try {
      const workDir = await runCorrectionAgent(issue.number, branch, prompt, useCodex);
      await deployAndNotify(issue.number, branch, workDir);
    } finally {
      processing.delete(issue.number);
    }
  }
}

async function deployAndNotify(issueNumber: number, branch: string, workDir: string): Promise<void> {

  // Verificar si hay commits nuevos
  const baseBranch = branch.startsWith("internal/mutation-") ? "release" : "hotfix-master";
  const hasCommits = (await git(workDir, "log", "--oneline", `origin/${baseBranch}..HEAD`)).length > 0;
  if (!hasCommits) return;

  // Build
  console.log("🔨 Build para deploy...");
  try {
    await exec("npm", ["run", config.deployBuildCmd], { cwd: workDir, env: AGENT_ENV, maxBuffer: 1024 * 1024 * 100, timeout: 300_000 });
  } catch (e) {
    console.warn("⚠️ Build falló, saltando deploy");
    return;
  }

  // Deploy
  const containerName = `nf-${branch.replace(/\//g, "-")}`.toLowerCase();
  const tarFile = "/tmp/agent-deploy.tar.gz";
  await exec("tar", ["czf", tarFile, "dist/narobial", "etc/default.conf", "etc/nginx.crt", "etc/nginx.key"], { cwd: workDir, env: AGENT_ENV });

  const sshOpts = ["-i", config.deploySshKey, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=30"];
  const remote = `root@${config.deployHost}`;
  await exec("scp", [...sshOpts, tarFile, `${remote}:/tmp/agent-deploy.tar.gz`], { env: AGENT_ENV });

  const remoteScript = `
set -e
DIR="/tmp/agent-build-$$"
mkdir -p "$DIR" && cd "$DIR"
tar xzf /tmp/agent-deploy.tar.gz
cat > Dockerfile <<DEOF
FROM nginx:1.29-alpine
COPY etc/nginx.crt /etc/nginx/ssl/nginx.crt
COPY etc/nginx.key /etc/nginx/ssl/nginx.key
COPY dist/narobial /usr/share/nginx/html
COPY etc/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 443
CMD ["nginx", "-g", "daemon off;"]
DEOF
docker build -t "${containerName}" . >/dev/null 2>&1
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

  const { stdout } = await exec("ssh", [...sshOpts, remote, remoteScript], { env: AGENT_ENV, maxBuffer: 1024 * 1024 * 10, timeout: 300_000 });
  const port = stdout.trim().split("\n").pop()?.trim() || null;

  if (port) {
    const deployUrl = `https://${config.deployHost}:${port}`;
    console.log(`✅ Deploy: ${deployUrl}`);

    // Email
    try {
      const { default: nodemailer } = await import("nodemailer");
      const transporter = nodemailer.createTransport({ host: "smtp-relay.gmail.com", port: 25, secure: false, tls: { rejectUnauthorized: false } });
      await transporter.sendMail({
        from: "noreply@quiter.com",
        to: "guillermo.calleja@quiter.com",
        cc: "jaime.garcia@narobial.net, dilan.milla@narobial.net, elder.bol@narobial.net, juan.munoz@narobial.net",
        subject: `✅ [Symphony] Corrección desplegada — Issue #${issueNumber}`,
        html: `<h2>✅ Corrección desplegada — Issue #${issueNumber}</h2>
<p>Rama: <code>${branch}</code></p>
<h3>🚀 URL de prueba:</h3>
<p><a href="${deployUrl}">${deployUrl}</a></p>
<p><a href="https://github.com/${config.repo}/issues/${issueNumber}">Ver issue</a></p>
<p>Por favor verificar los cambios.</p>`,
      });
      console.log("📧 Email enviado a reviewers");
    } catch (e) {
      console.warn("⚠️ Email falló:", (e as Error).message);
    }
  }
}
