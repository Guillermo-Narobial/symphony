import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import nodemailer from "nodemailer";
import { config } from "./config.js";

interface RecipientRoute {
  primary: string;
  fallback?: string;
}

const MAIL_RETRY_ATTEMPTS = 10;
const MAIL_RETRY_DELAY_MS = 60_000;
const ONLY_FIXED_RECIPIENTS = process.env.PROJECTS_REPORT_ONLY_FIXED_RECIPIENTS === "true";
const REPORT_STATE_PATH = resolve(process.env.PROJECTS_REPORT_STATE_FILE ?? "./.projects-report-state.json");

const FIXED_SUMMARY_RECIPIENTS: RecipientRoute[] = [
  {
    primary: "guillermo.calleja@quiter.com",
    fallback: "guillermo.calleja@narobial.net",
  },
  {
    primary: "jaime.garcia@quiter.com",
    fallback: "jaime.garcia@narobial.net",
  },
];

interface Resource {
  resourceId: string;
  endDate: string;
  startDate: string;
}

interface WorkItem {
  id: string;
  title: string;
  statusId: string;
  analystDeveloperId: string;
  estimatedDevelopmentEndDate: string;
  closingDate?: string;
  isQ700?: boolean;
  resources?: Resource[];
}

interface ProjectSections {
  expiringToday: WorkItem[];
  q700ExpiringToday: WorkItem[];
  devExpired: WorkItem[];
  pilotInterno: WorkItem[];
  pilotSac: WorkItem[];
}

interface DeliveryRecord {
  sentAt: string;
  address: string;
}

interface DeliveryState {
  days?: Record<string, Record<string, DeliveryRecord>>;
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
  efalcon: "elena.falcon@narobial.net",
};

const EXCLUDED_RESOURCES = ["gcalleja", "jgarcia"];

const SEARCH_VALUES = ["gcalleja", "jgarcia"];

async function fetchItems(method: string): Promise<WorkItem[]> {
  const customInterface = JSON.stringify({
    interfaces: ["id", "analystDeveloperId", "assignedDate", "brandId", "closingDate", "countryId", "creationDate", "creationHour", "creationUser", "customerId", "customerRequirements", "groupId", "isClosed", "isNarobial", "isOpened", "isProject", "isQ700", "isQuiter", "isSuggestion", "projectManagerId", "requirements", "statusId", "title", "typeId", "uploadDate", "userCode", "narobialAppVersion", "estimatedDevelopmentEndDate", "developmentEndDate", "developmentStartDate", "pilotDate", "resources.resourceId", "resources.startDate", "resources.endDate"],
  });

  const all = new Map<string, WorkItem>();

  for (const searchValue of SEARCH_VALUES) {
    const res = await fetch(config.dmsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        "access-token": config.dmsAccessToken,
        ClientId: config.dmsClientId,
        metododms: method,
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

async function fetchProjects(): Promise<WorkItem[]> {
  return fetchItems("GET.PROYECTOS");
}

async function fetchQ700s(): Promise<WorkItem[]> {
  return fetchItems("GET.Q700");
}

function getResourceIds(p: WorkItem): string {
  if (!p.resources || p.resources.length === 0) return p.analystDeveloperId.replace(/²/g, ", ");
  return [...new Set(p.resources.map((r) => r.resourceId))].join(", ");
}

function buildSections(projects: WorkItem[], q700s: WorkItem[]): ProjectSections {
  const today = new Date().toISOString().slice(0, 10);
  const expiringToday = projects.filter(
    (p) => p.statusId === "P06" && p.estimatedDevelopmentEndDate === today
  );
  const q700ExpiringToday = q700s.filter(
    (q) => q.isQ700 !== false
      && q.estimatedDevelopmentEndDate === today
      && (q.statusId === "Q2" || q.statusId === "Q3")
  );

  const devExpired: WorkItem[] = [];
  const pilotInterno: WorkItem[] = [];
  const pilotSac: WorkItem[] = [];

  for (const p of projects) {
    if (p.statusId === "P06" && p.estimatedDevelopmentEndDate && p.estimatedDevelopmentEndDate < today) {
      devExpired.push(p);
    } else if (p.statusId === "P07") {
      pilotInterno.push(p);
    } else if (p.statusId === "P09") {
      pilotSac.push(p);
    }
  }

  return { expiringToday, q700ExpiringToday, devExpired, pilotInterno, pilotSac };
}

function buildHtml(sections: ProjectSections): string {
  const today = new Date().toISOString().slice(0, 10);
  const { expiringToday, q700ExpiringToday, devExpired, pilotInterno, pilotSac } = sections;

  let html = `<h1>⚠️ Resumen diario de proyectos</h1>`;

  html += `<h2>📅 Proyectos en Desarrollo que caducan hoy (${today})</h2>`;
  if (expiringToday.length === 0) {
    html += `<p>Ninguno</p>`;
  } else {
    const rows = expiringToday
      .map((p) => `<tr><td>${p.id}</td><td>${p.title}</td><td>${getResourceIds(p)}</td></tr>`)
      .join("");
    html += `<table border="1" cellpadding="6" cellspacing="0">
<tr><th>ID</th><th>Título</th><th>Desarrollador</th></tr>
${rows}
</table>`;
  }

  html += `<h2>🧾 Q700 que caducan hoy (${today})</h2>`;
  if (q700ExpiringToday.length === 0) {
    html += `<p>Ninguna</p>`;
  } else {
    const rows = q700ExpiringToday
      .map((q) => `<tr><td>${q.id}</td><td>${q.title}</td><td>${getResourceIds(q)}</td><td>${q.estimatedDevelopmentEndDate ?? ""}</td></tr>`)
      .join("");
    html += `<table border="1" cellpadding="6" cellspacing="0">
<tr><th>ID</th><th>Título</th><th>Desarrollador</th><th>Fecha estimada fin</th></tr>
${rows}
</table>`;
  }

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

function getFallbackEmail(email: string): string | undefined {
  if (email.endsWith("@quiter.com")) return email.replace("@quiter.com", "@narobial.net");
  if (email.endsWith("@narobial.net")) return email.replace("@narobial.net", "@quiter.com");
  return undefined;
}

function getProjectResourceIds(project: WorkItem): string[] {
  const ids = new Set<string>();

  for (const rawId of project.analystDeveloperId.split("²")) {
    const id = rawId.trim();
    if (id) ids.add(id);
  }

  for (const resource of project.resources ?? []) {
    if (resource.resourceId) ids.add(resource.resourceId);
  }

  return [...ids];
}

function filterProjectsForResource(projects: WorkItem[], resourceId: string): WorkItem[] {
  return projects.filter((project) => getProjectResourceIds(project).includes(resourceId));
}

function buildSectionsForResource(sections: ProjectSections, resourceId: string): ProjectSections {
  return {
    expiringToday: filterProjectsForResource(sections.expiringToday, resourceId),
    q700ExpiringToday: filterProjectsForResource(sections.q700ExpiringToday, resourceId),
    devExpired: filterProjectsForResource(sections.devExpired, resourceId),
    pilotInterno: filterProjectsForResource(sections.pilotInterno, resourceId),
    pilotSac: filterProjectsForResource(sections.pilotSac, resourceId),
  };
}

function hasAnyProjects(sections: ProjectSections): boolean {
  return sections.expiringToday.length > 0
    || sections.q700ExpiringToday.length > 0
    || sections.devExpired.length > 0
    || sections.pilotInterno.length > 0
    || sections.pilotSac.length > 0;
}

async function readDeliveryState(): Promise<DeliveryState> {
  try {
    return JSON.parse(await readFile(REPORT_STATE_PATH, "utf-8")) as DeliveryState;
  } catch {
    return { days: {} };
  }
}

async function writeDeliveryState(state: DeliveryState): Promise<void> {
  await mkdir(dirname(REPORT_STATE_PATH), { recursive: true });
  await writeFile(REPORT_STATE_PATH, JSON.stringify(state, null, 2));
}

function wasDelivered(state: DeliveryState, day: string, recipientKey: string): boolean {
  return Boolean(state.days?.[day]?.[recipientKey]);
}

async function markDelivered(state: DeliveryState, day: string, recipientKey: string, address: string): Promise<void> {
  if (!state.days) state.days = {};
  if (!state.days[day]) state.days[day] = {};
  state.days[day][recipientKey] = {
    sentAt: new Date().toISOString(),
    address,
  };

  const retentionDays = 14;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffDay = cutoff.toISOString().slice(0, 10);

  for (const existingDay of Object.keys(state.days)) {
    if (existingDay < cutoffDay) delete state.days[existingDay];
  }

  await writeDeliveryState(state);
}

function getPersonalizedRecipientRoutes(sections: ProjectSections): Array<{ resourceId: string; route: RecipientRoute }> {
  const recipients = new Map<string, { resourceId: string; route: RecipientRoute }>();

  const relevantProjects = [
    ...sections.expiringToday,
    ...sections.q700ExpiringToday,
    ...sections.devExpired,
    ...sections.pilotInterno,
    ...sections.pilotSac,
  ];

  for (const project of relevantProjects) {
    for (const resourceId of getProjectResourceIds(project)) {
      if (EXCLUDED_RESOURCES.includes(resourceId)) continue;
      const primary = RESOURCE_EMAILS[resourceId];
      if (!primary || recipients.has(resourceId)) continue;
      recipients.set(resourceId, {
        resourceId,
        route: { primary, fallback: getFallbackEmail(primary) },
      });
    }
  }

  return [...recipients.values()];
}

async function sendMailToRoute(
  transporter: nodemailer.Transporter,
  route: RecipientRoute,
  subject: string,
  html: string,
): Promise<string> {
  const mail = { from: "noreply@narobial.net", subject, html };

  for (let attempt = 1; attempt <= MAIL_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await transporter.sendMail({ ...mail, to: route.primary });
      console.log(`📧 Email enviado a: ${route.primary} (intento ${attempt}/${MAIL_RETRY_ATTEMPTS})`);
      return route.primary;
    } catch (primaryErr) {
      const primaryMessage = (primaryErr as Error).message;
      console.warn(`⚠️ Fallo con ${route.primary} (intento ${attempt}/${MAIL_RETRY_ATTEMPTS}): ${primaryMessage}`);

      if (route.fallback) {
        try {
          await transporter.sendMail({ ...mail, to: route.fallback });
          console.log(`📧 Email enviado (fallback) a: ${route.fallback} (intento ${attempt}/${MAIL_RETRY_ATTEMPTS})`);
          return route.fallback;
        } catch (fallbackErr) {
          const fallbackMessage = (fallbackErr as Error).message;
          console.warn(`⚠️ Fallo con fallback ${route.fallback} (intento ${attempt}/${MAIL_RETRY_ATTEMPTS}): ${fallbackMessage}`);
        }
      }

      if (attempt < MAIL_RETRY_ATTEMPTS) {
        console.log(`⏳ Reintentando envío en ${MAIL_RETRY_DELAY_MS / 1000}s para ${route.primary}`);
        await new Promise((resolve) => setTimeout(resolve, MAIL_RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(`No se pudo enviar el email a ${route.primary} tras ${MAIL_RETRY_ATTEMPTS} intentos`);
}

async function main(): Promise<void> {
  console.log("📋 Projects Report — inicio");
  const projects = await fetchProjects();
  console.log(`  Recibidos ${projects.length} proyectos`);
  const q700s = await fetchQ700s();
  console.log(`  Recibidos ${q700s.length} Q700`);

  const sections = buildSections(projects, q700s);
  const html = buildHtml(sections);
  const today = new Date().toISOString().slice(0, 10);
  const subject = `⚠️ [Symphony] Estado diario de proyectos — ${today}`;
  const deliveryState = await readDeliveryState();

  const transporter = nodemailer.createTransport({
    host: "smtp-relay.gmail.com",
    port: 465,
    secure: true,
  });

  for (const recipient of FIXED_SUMMARY_RECIPIENTS) {
    const recipientKey = `fixed:${recipient.primary.toLowerCase()}`;
    if (wasDelivered(deliveryState, today, recipientKey)) {
      console.log(`↩️ Resumen fijo ya enviado hoy a ${recipient.primary}. Se omite duplicado.`);
      continue;
    }

    try {
      const deliveredAddress = await sendMailToRoute(transporter, recipient, subject, html);
      await markDelivered(deliveryState, today, recipientKey, deliveredAddress);
    } catch (err) {
      console.error(`❌ No se pudo enviar el resumen fijo a ${recipient.primary}:`, err);
    }
  }

  if (!ONLY_FIXED_RECIPIENTS) {
    const personalizedRecipients = getPersonalizedRecipientRoutes(sections);
    for (const { resourceId, route } of personalizedRecipients) {
      const recipientKey = `resource:${resourceId}`;
      if (wasDelivered(deliveryState, today, recipientKey)) {
        console.log(`↩️ Resumen personalizado ya enviado hoy a ${route.primary} (${resourceId}). Se omite duplicado.`);
        continue;
      }

      const personalizedSections = buildSectionsForResource(sections, resourceId);
      if (!hasAnyProjects(personalizedSections)) continue;
      const personalizedHtml = buildHtml(personalizedSections);

      try {
        const deliveredAddress = await sendMailToRoute(transporter, route, subject, personalizedHtml);
        await markDelivered(deliveryState, today, recipientKey, deliveredAddress);
      } catch (err) {
        console.error(`❌ No se pudo enviar el resumen personalizado a ${route.primary} (${resourceId}):`, err);
      }
    }
  } else {
    console.log("ℹ️ Ejecución manual restringida a destinatarios fijos");
  }
}

main().catch((err) => {
  console.error("❌ Error en projects-report:", err);
  process.exit(1);
});
