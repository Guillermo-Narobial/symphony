/**
 * Consulta de horario de empleados (entidad QUSUARIO, método GET.QUSUARIOS).
 *
 * Reutiliza el patrón de petición al DMS, pero con su propia entidad,
 * método, custominterface y clave de respuesta ("users").
 *
 * Filtro: { name: "*<texto>*" } — busca por nombre completo con comodines.
 */
import { config } from "./config.js";

export interface Empleado {
  name?: string;
  email?: string;
  telephone?: string;
  schedule?: string;
  isActive?: unknown;
  onlyNight?: unknown;
}

const QUSUARIOS_CUSTOM_INTERFACE = JSON.stringify({
  interfaces: ["isActive", "email", "name", "telephone", "schedule"],
});
const DMS_TIMEOUT_MS = 60_000;

/**
 * Busca empleados cuyo nombre contenga `query` y devuelve sus datos de horario.
 * `query` es el texto tal cual escribe el usuario; se envuelve en comodines.
 * Puede devolver un array vacío si no hay coincidencias.
 */
export async function fetchHorarioEmpleado(query: string): Promise<Empleado[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DMS_TIMEOUT_MS);

  try {
    const res = await fetch(config.dmsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        "access-token": config.dmsAccessToken,
        ClientId: config.dmsClientId,
        metododms: "GET.QUSUARIOS",
        entidadDms: "QUSUARIO",
        methodtype: config.dmsMethodType,
        servercode: config.dmsServerCode,
        headers: config.dmsHeaders,
        custominterface: QUSUARIOS_CUSTOM_INTERFACE,
      },
      body: JSON.stringify({
        queryParams: { name: `*${query}*` },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // El DMS responde 500 con "no_records_found" cuando no hay coincidencias:
      // se trata como "sin resultados", no como error.
      const data = (await res.json().catch(() => null)) as
        | { message?: { errors?: Array<{ code?: string }> } }
        | null;
      const code = data?.message?.errors?.[0]?.code;
      if (code === "no_records_found") return [];
      throw new Error(`DMS error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { users?: Empleado[] };
    return Array.isArray(data.users) ? data.users : [];
  } finally {
    clearTimeout(timeout);
  }
}
