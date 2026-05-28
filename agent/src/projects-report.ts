import "dotenv/config";
import nodemailer from "nodemailer";
import { config } from "./config.js";

const RECIPIENTS = [
  "guillermo.calleja@narobial.net",
  "jaime.garcia@narobial.net",
];

const FALLBACK_RECIPIENTS = [
  "guillermo.calleja@quiter.com",
  "jaime.garcia@quiter.com",
];

interface Resource {
  resourceId: string;
  endDate: string;
  startDate: string;
}

interface Project {
  id: string;
  title: string;
  statusId: string;
  analystDeveloperId: string;
  estimatedDevelopmentEndDate: string;
  resources?: Resource[];
}

const RESOURCE_EMAILS: Record<string, string> = {
  arodriguez: "adriana.rodriguez@narobial.net",
  babuhassira: "basma.abuhassira@narobial.net",
  cvillanueva: "carlos.villanueva@narobial.net",
  dmilla: "dilan.milla@narobial.net",
  ebol: "elder.bol@narobial.net",
  fgomez: "fernando.gomez@narobial.net",
  jmmerino: "jose.merino@narobial.net",
  jrodezno: "jose.rodezno@narobial.net",
  jflira: "juan.lira@narobial.net",
  jpmunoz: "juan.munoz@narobial.net",
  ncruz: "natalia.cruz@narobial.net",
  obarrios: "omar.barrios@narobial.net",
  pmallavia: "pablo.mallavia@narobial.net",
  vmadera: "victor.madera@narobial.net",
};

const EXCLUDED_RESOURCES = ["gcalleja", "jgarcia"];

const SEARCH_VALUES = ["gcalleja", "jgarcia"];

async function fetchProjects(): Promise<Project[]> {
  const customInterface = JSON.stringify({
    interfaces: ["id", "analystDeveloperId", "assignedDate", "brandId", "closingDate", "countryId", "creationDate", "creationHour", "creationUser", "customerId", "customerRequirements", "groupId", "isClosed", "isNarobial", "isOpened", "isProject", "isQ700", "isQuiter", "isSuggestion", "projectManagerId", "requirements", "statusId", "title", "typeId", "uploadDate", "userCode", "narobialAppVersion", "estimatedDevelopmentEndDate", "developmentEndDate", "developmentStartDate", "pilotDate", "resources.resourceId", "resources.startDate", "resources.endDate"],
  });

  const all = new Map<string, Project>();

  for (const searchValue of SEARCH_VALUES) {
    const res = await fetch(config.dmsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        "access-token": config.dmsAccessToken,
        ClientId: config.dmsClientId,
        metododms: "GET.PROYECTOS",
        entidadDms: config.dmsEntidad,
        methodtype: config.dmsMethodType,
        servercode: config.dmsServerCode,
        headers: config.dmsHeaders,
        custominterface: customInterface,
      },
      body: JSON.stringify({
        queryParams: { searchValue, isOpened: true },
      }),
    });
    if (!res.ok) throw new Error(`DMS error (${searchValue}): ${res.status}`);
    const data = await res.json();
    const procedures = Array.isArray(data.procedures) ? data.procedures : [];
    for (const p of procedures) all.set(p.id, p);
  }

  return [...all.values()];
}

function getResourceIds(p: Project): string {
  if (!p.resources || p.resources.length === 0) return p.analystDeveloperId.replace(/²/g, ", ");
  return [...new Set(p.resources.map((r) => r.resourceId))].join(", ");
}

function buildHtml(projects: Project[]): string {
  const today = new Date().toISOString().slice(0, 10);

  // Bloque 1: Proyectos en desarrollo que caducan HOY
  const expiringToday = projects.filter(
    (p) => p.statusId === "P06" && p.estimatedDevelopmentEndDate === today
  );

  // Bloques con fecha vencida (anterior a hoy) — solo desarrollo
  const devExpired: Project[] = [];
  // Pilotajes: todos los que estén en ese estado (sin filtro de fecha)
  const pilotInterno: Project[] = [];
  const pilotSac: Project[] = [];

  for (const p of projects) {
    if (p.statusId === "P06" && p.estimatedDevelopmentEndDate && p.estimatedDevelopmentEndDate < today) {
      devExpired.push(p);
    } else if (p.statusId === "P07") {
      pilotInterno.push(p);
    } else if (p.statusId === "P09") {
      pilotSac.push(p);
    }
  }

  // Sección caducan hoy
  let html = `<h1>⚠️ Resumen diario de proyectos</h1>`;

  html += `<h2>📅 Proyectos en Desarrollo que caducan hoy (${today})</h2>`;
  if (expiringToday.length === 0) {
    html += `<p>Ninguno</p>`;
  } else {
    const rows = expiringToday
      .map((p) => `<tr><td>${p.id}</td><td>${p.title}</td><td>${p.analystDeveloperId.replace(/²/g, ", ")}</td></tr>`)
      .join("");
    html += `<table border="1" cellpadding="6" cellspacing="0">
<tr><th>ID</th><th>Título</th><th>Desarrollador</th></tr>
${rows}
</table>`;
  }

  // Desarrollo vencidos
  html += `<h2>🔧 Proyectos en Desarrollo con fecha vencida</h2>`;
  if (devExpired.length === 0) {
    html += `<p>Sin proyectos</p>`;
  } else {
    const rows = devExpired
      .map((p) => `<tr><td>${p.id}</td><td>${p.title}</td><td>${p.analystDeveloperId.replace(/²/g, ", ")}</td><td>${p.estimatedDevelopmentEndDate}</td></tr>`)
      .join("");
    html += `<table border="1" cellpadding="6" cellspacing="0">
<tr><th>ID</th><th>Título</th><th>Desarrollador</th><th>Fecha estimada fin</th></tr>
${rows}
</table>`;
  }

  // Pilotaje interno (todos)
  html += `<h2>🧪 Proyectos en Pilotaje Interno</h2>`;
  if (pilotInterno.length === 0) {
    html += `<p>Sin proyectos</p>`;
  } else {
    const rows = pilotInterno
      .map((p) => `<tr><td>${p.id}</td><td>${p.title}</td><td>${getResourceIds(p)}</td></tr>`)
      .join("");
    html += `<table border="1" cellpadding="6" cellspacing="0">
<tr><th>ID</th><th>Título</th><th>Desarrollador</th></tr>
${rows}
</table>`;
  }

  // Pilotaje SAC (todos)
  html += `<h2>🏢 Proyectos en Pilotaje SAC</h2>`;
  if (pilotSac.length === 0) {
    html += `<p>Sin proyectos</p>`;
  } else {
    const rows = pilotSac
      .map((p) => `<tr><td>${p.id}</td><td>${p.title}</td><td>${getResourceIds(p)}</td></tr>`)
      .join("");
    html += `<table border="1" cellpadding="6" cellspacing="0">
<tr><th>ID</th><th>Título</th><th>Desarrollador</th></tr>
${rows}
</table>`;
  }

  return html;
}

async function notifyResources(projects: Project[], transporter: nodemailer.Transporter): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  // Agrupar proyectos que vencen hoy por recurso (excluyendo gcalleja/jgarcia)
  const notifications = new Map<string, { email: string; projects: { id: string; title: string; endDate: string }[] }>();

  for (const p of projects) {
    if (!p.resources || p.statusId !== "P06") continue;
    // Para cada recurso, encontrar su endDate más reciente
    const byResource = new Map<string, string>();
    for (const r of p.resources) {
      if (EXCLUDED_RESOURCES.includes(r.resourceId)) continue;
      const current = byResource.get(r.resourceId);
      if (!current || r.endDate > current) byResource.set(r.resourceId, r.endDate);
    }
    // Si la fecha más reciente es hoy, notificar
    for (const [resourceId, endDate] of byResource) {
      if (endDate !== today) continue;
      const email = RESOURCE_EMAILS[resourceId];
      if (!email) continue;
      if (!notifications.has(resourceId)) notifications.set(resourceId, { email, projects: [] });
      notifications.get(resourceId)!.projects.push({ id: p.id, title: p.title, endDate });
    }
  }

  for (const [resourceId, { email, projects: projs }] of notifications) {
    const rows = projs.map((p) => `<tr><td>${p.id}</td><td>${p.title}</td><td>${p.endDate}</td></tr>`).join("");
    const html = `<p>Hola,</p>
<p>Los siguientes proyectos asignados a ti vencen <strong>hoy (${today})</strong>:</p>
<table border="1" cellpadding="6" cellspacing="0">
<tr><th>ID</th><th>Título</th><th>Fecha fin</th></tr>
${rows}
</table>
<p>Si no puedes cumplir con la fecha acordada, por favor solicita una ampliación de fechas.</p>
<p>— Symphony</p>`;
    const subject = `⏰ [Symphony] Tu proyecto vence hoy — ${today}`;
    try {
      await transporter.sendMail({ from: "noreply@narobial.net", to: email, subject, html });
      console.log(`📧 Notificación individual enviada a ${resourceId} (${email})`);
    } catch (err) {
      console.warn(`⚠️ Fallo con ${email}, reintentando con fallback:`, (err as Error).message);
      const fallbackEmail = email.replace("@narobial.net", "@quiter.com");
      try {
        await transporter.sendMail({ from: "noreply@narobial.net", to: fallbackEmail, subject, html });
        console.log(`📧 Notificación individual (fallback) enviada a ${resourceId} (${fallbackEmail})`);
      } catch (err2) {
        console.error(`❌ Error enviando a ${resourceId} (fallback):`, (err2 as Error).message);
      }
    }
  }
}

async function main(): Promise<void> {
  console.log("📋 Projects Report — inicio");
  const projects = await fetchProjects();
  console.log(`  Recibidos ${projects.length} proyectos`);

  const html = buildHtml(projects);
  const subject = `⚠️ [Symphony] Proyectos con fecha vencida — ${new Date().toISOString().slice(0, 10)}`;

  const transporter = nodemailer.createTransport({
    host: "smtp-relay.gmail.com",
    port: 465,
    secure: true,
  });

  try {
    await transporter.sendMail({ from: "noreply@narobial.net", to: RECIPIENTS.join(", "), subject, html });
    console.log("📧 Email enviado a:", RECIPIENTS.join(", "));
  } catch (err) {
    console.warn("⚠️ Fallo con recipients primarios, reintentando con fallback:", (err as Error).message);
    await transporter.sendMail({ from: "noreply@narobial.net", to: FALLBACK_RECIPIENTS.join(", "), subject, html });
    console.log("📧 Email enviado (fallback) a:", FALLBACK_RECIPIENTS.join(", "));
  }

  await notifyResources(projects, transporter);
}

main().catch((err) => {
  console.error("❌ Error en projects-report:", err);
  process.exit(1);
});
