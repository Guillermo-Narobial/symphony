import "dotenv/config";
import { createIssue } from "./issuer.js";
import { runAgent } from "./runner.js";
import { syncRepos } from "./repos.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);

const task = {
  id: "P05942026ES",
  title: "Apertura de OR: ERROR con la carga de kits ty avisos ",
  requirements: "En el proceso de apertura de una OR, en uno de los passos se está piediendo los kits y los avisos a la vez, no deben de de ser dependientes, porque no se puede pasar de paso hasta que se reciban los avisos.²²Para la aceptación de este proyecto/incidencia tiene que cumplir con los siguientes requerimientos: ²²1-La carga de avisos no debe depender de la carga de kits. ²²2-No se puede avanzar de paso hasta que no carguen los avisos. Hasta que no finaliza esta petición no sabemos si existen avisos obligatorios, y si no bloqueamos el botón, el usuario se puede saltar esa restricción.",
  creationUser: "gcalleja",
  isNarobial: true,
  analystDeveloperId: "gcalleja",
  creationDate: "2026-05-05",
  userCode: "0594/2026-ES",
  countryId: "ES",
  isProject: true,
  statusId: "P05",
  customerRequirements: "Se trata de un proyecto con IA , para la automatización en la creación, desarrollo, gestión y validación de incidencias.",
  brandId: "GEN",
  customerId: "2584",
  projectManagerId: "gcalleja",
};

async function main() {
  console.log("🔄 Sincronizando repos...");
  await syncRepos();

  console.log("📝 Creando issue P05942026ES...");
  const url = await createIssue(task);
  console.log(`✅ Issue: ${url}`);

  // Extraer número de issue de la URL
  const match = url.match(/issues\/(\d+)/);
  if (!match) {
    console.log("⚠️  Issue ya existía, buscando número...");
    const { stdout } = await exec("gh", [
      "issue", "list", "-R", config.repo,
      "--state", "open", "--search", "P05942026ES in:title",
      "--json", "number,title,body", "--limit", "1",
    ]);
    const issues = JSON.parse(stdout);
    if (issues.length === 0) throw new Error("No se encontró la issue");
    const issue = issues[0];
    console.log(`🤖 Lanzando solver para #${issue.number}...`);
    await runAgent(issue.number, issue.title, issue.body, "hotfix-master");
  } else {
    const num = Number(match[1]);
    // Obtener body completo
    const { stdout } = await exec("gh", [
      "issue", "view", String(num), "-R", config.repo, "--json", "body",
    ]);
    const body = JSON.parse(stdout).body;
    console.log(`🤖 Lanzando solver para #${num}...`);
    await runAgent(num, `P05942026ES: ${task.title}`, body, "hotfix-master");
  }

  console.log("🏁 Agente terminó");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
