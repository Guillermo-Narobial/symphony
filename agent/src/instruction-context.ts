export interface InstructionDomain {
  id: string;
  name: string;
  doc: string;
  keywords: string[];
  pathHints: string[];
}

interface InstructionContextRoute {
  domains: InstructionDomain[];
  reason: string;
}

const DOMAIN_RULES: InstructionDomain[] = [
  {
    id: "scheduler",
    name: "SCHEDULER",
    doc: "docs/agents/scheduler.md",
    keywords: ["scheduler", "planificador", "planning", "timeline", "operario", "tarea taller", "task scheduler", "fichaje"],
    pathHints: ["views/scheduler/", "components/task-scheduler/", "components/modals/scheduler/", "views/appointment/step2-scheduler/"],
  },
  {
    id: "kanban",
    name: "KANBAN",
    doc: "docs/agents/kanban.md",
    keywords: ["kanban", "easy planner", "tablero", "tarjeta", "mecanico", "mecánico", "fase taller"],
    pathHints: ["views/kanban/", "views/easy-planner-editor/", "components/easy-planner/", "components/modals/kanban/", "components/modals/easy-planner/"],
  },
  {
    id: "advanced-offer",
    name: "OFERTA AVANZADA",
    doc: "docs/agents/advanced-offer.md",
    keywords: ["oferta", "advanced offer", "volvo", "arval", "renting", "tasacion", "tasación", "vehiculo vo", "vehículo vo"],
    pathHints: ["views/advanced-offer/", "components/advanced-offers/", "components/offer-vehicle-card/", "components/modals/offers/"],
  },
  {
    id: "repair-order",
    name: "APERTURA OR",
    doc: "docs/agents/repair-order.md",
    keywords: ["orden de reparacion", "orden de reparación", "repair order", "or", "apertura or", "inspeccion visual", "inspección visual", "kit", "trabajo", "mo"],
    pathHints: ["views/repair-order/", "components/wizard/repair-order/", "components/blocks/repair-order/", "components/modals/repair-order/"],
  },
  {
    id: "appointment",
    name: "APERTURA CITA",
    doc: "docs/agents/appointment.md",
    keywords: ["cita", "appointment", "slot", "agenda", "preparacion cita", "preparación cita", "appointment viewer"],
    pathHints: ["views/appointment/", "components/wizard/appointments/", "components/blocks/appointment/", "views/appointment-viewer/", "views/mobile/appointment/"],
  },
  {
    id: "masters",
    name: "MASTERS",
    doc: "docs/agents/masters.md",
    keywords: ["master", "masters", "maestro", "dtd", "fichero maestro", "tabla dinamica", "tabla dinámica", "bnc_entities"],
    pathHints: ["views/masters/", "views/master-budget-list/", "components/modals/masters/", "services/helpers/api/bnc_entities.ts"],
  },
];

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function routeInstructionContext(title: string, body: string): InstructionContextRoute {
  const text = normalize(`${title}\n${body}`);
  const domains = DOMAIN_RULES.filter((domain) => {
    const keywordMatch = domain.keywords.some((keyword) => text.includes(normalize(keyword)));
    const pathMatch = domain.pathHints.some((path) => text.includes(normalize(path)));
    return keywordMatch || pathMatch;
  });

  if (domains.length === 0) {
    return {
      domains: [],
      reason: "No se detectó dominio especializado por título, cuerpo ni rutas mencionadas.",
    };
  }

  return {
    domains,
    reason: `Dominio(s) detectado(s): ${domains.map((domain) => domain.name).join(", ")}.`,
  };
}

export function buildInstructionContext(title: string, body: string): string {
  const route = routeInstructionContext(title, body);
  const domainDocs = route.domains.map((domain) => `- ${domain.name}: \`${domain.doc}\``).join("\n");
  const fallback = "- Sin dominio especializado inicial: lidera `narobial-frontend` principal y usa `docs/agents/AGENTS.md` como mapa de delegación.";

  return `## Contexto de instrucciones dirigido

${route.reason}

### Documentos a cargar primero

- \`AGENTS.md\`
- \`docs/agents/AGENTS.md\`
${domainDocs || fallback}

### Politica de contexto

- No cargues \`INSTRUCTIONS.md\` completo al inicio: pesa mucho y duplica reglas de dominio.
- Consulta solo secciones concretas de \`INSTRUCTIONS.md\` cuando necesites reglas de testing, i18n, PR, changelog o seguridad que no estén cubiertas en los documentos anteriores.
- Si aparecen ficheros concretos durante el análisis, usa esta lista como punto de partida y amplía contexto solo con las fichas de dominio realmente afectadas.
- Si tocas funcionalidad de un dominio detectado, revisa y actualiza su ficha \`docs/agents/*.md\` cuando cambie comportamiento.
`;
}
