import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { Task } from "./schema.js";

const exec = promisify(execFile);

function normalize(text: string): string {
  return text
    .replace(/²²/g, "\n\n")
    .replace(/²/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

function buildLabels(task: Task): string[] {
  const labels: string[] = ["bug", "NAROBIAl", "ai-generated"];
  if (task.countryId) labels.push(`country:${task.countryId}`);
  if (task.customerId) labels.push(`customer:${task.customerId}`);
  if (task.brandId) labels.push(`brand:${task.brandId}`);
  if (task.isProject) labels.push("project");
  if (task.statusId) labels.push(`status:${task.statusId}`);
  return labels;
}

function buildBody(task: Task): string {
  const req = normalize(task.requirements || "");
  const custReq = task.customerRequirements ? normalize(task.customerRequirements) : "";

  return `## Requisitos originales

${req}

## Traduccion para agente de desarrollo

### Objetivo

Implementar o corregir la funcionalidad descrita en los requisitos originales.

### Problema detectado

${req.split("\n")[0]}

### Comportamiento esperado

El sistema debe cumplir todos los puntos descritos en los requisitos originales.

### Criterios de aceptacion

${req.split("\n").filter((l) => /^\d/.test(l.trim())).map((l) => `- ${l.trim()}`).join("\n") || "- Cumplir los requisitos originales descritos arriba."}

### Riesgos o restricciones funcionales

No romper funcionalidad existente. Respetar las restricciones de negocio indicadas en los requisitos.

## Contexto del cliente

${custReq || "No proporcionado."}

## Datos de origen NAROBIAl

| Campo | Valor |
| --- | --- |
| ID | \`${task.id}\` |
| Titulo NAROBIAl | \`${task.title}\` |
| Codigo usuario | \`${task.userCode || ""}\` |
| Pais | \`${task.countryId || ""}\` |
| Cliente | \`${task.customerId || ""}\` |
| Marca | \`${task.brandId || ""}\` |
| Estado | \`${task.statusId || ""}\` |
| Es proyecto | \`${task.isProject ?? ""}\` |
| Es Narobial | \`${task.isNarobial ?? ""}\` |
| Tipo | \`${task.typeId ?? ""}\` |
| Creado por | \`${task.creationUser ?? ""}\` |
| Analista/desarrollador | \`${task.analystDeveloperId || ""}\` |
| Project manager | \`${task.projectManagerId || ""}\` |
| Fecha creacion | \`${task.creationDate || ""}\` |

## Checklist para implementacion

- [ ] Identificar los flujos afectados.
- [ ] Implementar los cambios segun los requisitos.
- [ ] Verificar que no se rompe funcionalidad existente.
- [ ] Anadir pruebas o evidencias de validacion.
`;
}

export async function findExisting(id: string): Promise<number | null> {
  const { stdout } = await exec("gh", [
    "issue", "list",
    "-R", config.repo,
    "--state", "all",
    "--search", `${id} in:title,body`,
    "--json", "number,title,body",
    "--limit", "20",
  ]);
  const issues = JSON.parse(stdout) as Array<{ number: number; title: string; body: string }>;
  const match = issues.find((i) => i.title.includes(id) || i.body.includes(id));
  return match?.number ?? null;
}

async function ensureLabels(labels: string[]): Promise<string[]> {
  const { stdout } = await exec("gh", [
    "label", "list",
    "-R", config.repo,
    "--json", "name",
    "--limit", "200",
  ]);
  const existing = new Set((JSON.parse(stdout) as Array<{ name: string }>).map((l) => l.name));
  const valid: string[] = [];

  for (const label of labels) {
    if (!existing.has(label)) {
      try {
        await exec("gh", ["label", "create", label, "-R", config.repo, "--color", "BFD4F2"]);
      } catch { continue; }
    }
    valid.push(label);
  }
  return valid;
}

function writeTmp(content: string): string {
  const path = join(tmpdir(), `issue-${randomUUID()}.md`);
  writeFileSync(path, content);
  return path;
}

export async function createIssue(task: Task): Promise<string> {
  const existing = await findExisting(task.id);
  if (existing) return `https://github.com/${config.repo}/issues/${existing} (ya existía)`;

  const title = `${task.id}: ${task.title.trim()}`;
  const body = buildBody(task);
  const labels = await ensureLabels(buildLabels(task));
  const bodyFile = writeTmp(body);

  try {
    const args = [
      "issue", "create",
      "-R", config.repo,
      "--title", title,
      "--body-file", bodyFile,
      "--assignee", config.rejectAssignee,
    ];
    for (const l of labels) args.push("--label", l);

    const { stdout } = await exec("gh", args);
    const url = stdout.trim();

    // Asignar issue type via GraphQL
    const numMatch = url.match(/issues\/(\d+)/);
    if (numMatch) {
      const typeName = task.isProject ? "Feature" : "Bug";
      await setIssueType(Number(numMatch[1]), typeName);
    }

    return url;
  } finally {
    try { unlinkSync(bodyFile); } catch {}
  }
}

async function setIssueType(issueNumber: number, typeName: string): Promise<void> {
  const [owner, repo] = config.repo.split("/");

  // Obtener issue types del repo
  const { stdout: typesOut } = await exec("gh", ["api", "graphql", "-f", `query={
    repository(owner: "${owner}", name: "${repo}") {
      issueTypes(first: 20) { nodes { id name } }
    }
  }`]);
  const types = JSON.parse(typesOut).data.repository.issueTypes.nodes as Array<{ id: string; name: string }>;
  const typeId = types.find((t) => t.name === typeName)?.id;
  if (!typeId) return;

  // Obtener node ID de la issue
  const { stdout: issueOut } = await exec("gh", ["api", "graphql", "-f", `query={
    repository(owner: "${owner}", name: "${repo}") {
      issue(number: ${issueNumber}) { id }
    }
  }`]);
  const issueId = JSON.parse(issueOut).data.repository.issue.id;

  // Asignar tipo
  await exec("gh", ["api", "graphql", "-f", `query=mutation {
    updateIssue(input: { id: "${issueId}", issueTypeId: "${typeId}" }) {
      issue { id }
    }
  }`]);
}

/** Vincula una rama al campo Development de la issue */
export async function linkBranch(issueNumber: number, branchName: string): Promise<void> {
  await exec("gh", [
    "issue", "develop", String(issueNumber),
    "-R", config.repo,
    "--name", branchName,
    "--base", "hotfix-master",
  ]);
}

/** Actualiza el estado de la issue via labels */
export async function updateIssueStatus(issueNumber: number, status: "en-desarrollo" | "desarrollado" | "en-revision"): Promise<void> {
  const allStatuses = ["status:en-desarrollo", "status:desarrollado", "status:en-revision"];
  const target = `status:${status}`;

  await ensureLabels([target]);

  // Quitar labels de estado anteriores
  for (const s of allStatuses) {
    if (s !== target) {
      try {
        await exec("gh", ["issue", "edit", String(issueNumber), "-R", config.repo, "--remove-label", s]);
      } catch {}
    }
  }

  // Añadir el nuevo estado
  await exec("gh", ["issue", "edit", String(issueNumber), "-R", config.repo, "--add-label", target]);
}
