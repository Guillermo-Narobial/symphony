/**
 * Consulta de Q700 abiertos (isNarobial + statusId "Q1").
 *
 * Reutiliza el patrón de petición al DMS de projects-report.ts:
 * POST a config.dmsUrl con el método GET.Q700 y los headers estándar.
 *
 * Filtro de servidor: { isNarobial: true, isOpened: true }
 * Filtro en cliente:   statusId === "Q1"
 *
 * Nota: no se restringe por asignado (no se envía searchValue).
 */
import { config } from "./config.js";

export interface Q700Item {
  id: string;
  title: string;
  statusId: string;
  typeId?: unknown;
  isNarobial?: unknown;
  analystDeveloperId?: string;
  countryId?: string;
  brandId?: string;
  customerId?: string;
  creationUser?: string;
  creationDate?: string;
}

const Q_ABIERTOS_STATUS = "Q1";
const DMS_TIMEOUT_MS = 60_000;

/**
 * Devuelve los Q700 que son Narobial y están en estado Q1.
 * Puede devolver un array vacío (es un resultado válido y esperado).
 */
export async function fetchQabiertos(): Promise<Q700Item[]> {
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
        metododms: "GET.Q700",
        entidadDms: config.dmsEntidad,
        methodtype: config.dmsMethodType,
        servercode: config.dmsServerCode,
        headers: config.dmsHeaders,
        custominterface: config.dmsCustomInterface,
      },
      body: JSON.stringify({
        queryParams: { isNarobial: true, isOpened: true },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`DMS error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { procedures?: Q700Item[] };
    const procedures = Array.isArray(data.procedures) ? data.procedures : [];

    return procedures.filter((p) => String(p.statusId) === Q_ABIERTOS_STATUS);
  } finally {
    clearTimeout(timeout);
  }
}
