/**
 * Consultas sobre empleados (entidad QUSUARIO, método GET.QUSUARIOS).
 *
 * Clave de respuesta del DMS: "users".
 * Filtros soportados vía queryParams: { name: "*<texto>*" } o { idp }.
 */
import { config } from "./config.js";

export interface Empleado {
  idp?: string;
  name?: string;
  email?: string;
  telephone?: string;
  schedule?: string;
  isActive?: unknown;
  onlyNight?: unknown;
}

const HORARIO_INTERFACES = ["isActive", "email", "name", "telephone", "schedule"];
const IDP_INTERFACES = ["idp", "name", "email"];
const DMS_TIMEOUT_MS = 60_000;

/**
 * Petición base a GET.QUSUARIOS. Devuelve el array `users` (vacío si el DMS
 * responde `no_records_found`). Lanza sólo ante errores inesperados.
 */
async function queryQusuarios(
  queryParams: Record<string, unknown>,
  interfaces: string[],
): Promise<Empleado[]> {
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
        custominterface: JSON.stringify({ interfaces }),
      },
      body: JSON.stringify({ queryParams }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // El DMS responde 500 con "no_records_found" cuando no hay coincidencias.
      const data = (await res.json().catch(() => null)) as
        | { message?: { errors?: Array<{ code?: string }> } }
        | null;
      const code = data?.message?.errors?.[0]?.code;
      if (code === "no_records_found") return [];
      throw new Error(`DMS error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json().catch(() => null)) as { users?: Empleado[] } | null;
    return Array.isArray(data?.users) ? data!.users! : [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Busca empleados cuyo nombre contenga `query` y devuelve sus datos de horario.
 */
export async function fetchHorarioEmpleado(query: string): Promise<Empleado[]> {
  return queryQusuarios({ name: `*${query}*` }, HORARIO_INTERFACES);
}

/**
 * Busca empleados por nombre devolviendo idp + name (para resolver el idp
 * a partir de un nombre). Insensible a mayúsculas (lo maneja el DMS).
 */
export async function findEmpleadosByName(query: string): Promise<Empleado[]> {
  return queryQusuarios({ name: `*${query}*` }, IDP_INTERFACES);
}

/**
 * Resuelve el nombre completo de un empleado a partir de su IDP.
 * Best-effort: devuelve null si no se encuentra o falla.
 */
export async function fetchNombrePorIdp(idp: string): Promise<string | null> {
  try {
    const users = await queryQusuarios({ idp }, IDP_INTERFACES);
    return users[0]?.name ?? null;
  } catch {
    return null;
  }
}
