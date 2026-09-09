/**
 * Consulta del último fichaje de un empleado por IDP
 * (entidad CATALOGO, método GET.QFICHAJE).
 *
 * A diferencia de otras consultas, el filtro (idp) NO va en el body sino
 * dentro del header `headers`: {"headers":{"idp":"<idp>","profile":"App_qservers"}}.
 * El body sólo lleva {queryParams:{lastClockIn:true}}.
 *
 * La respuesta puede ser:
 *  - { procedures: [ ... ] }  → hay datos de fichaje
 *  - { message: { errors: [{ code, message }] } }  → cerrado / sin fichaje / idp inválido
 */
import { config } from "./config.js";

export interface CheckIn {
  id?: string;
  dateIn?: string;
  timeIn?: string;
  dateOut?: string;
  timeOut?: string;
}

export interface Qfichaje {
  id?: string;
  isCheckInActive?: boolean;
  isCheckedInToProject?: unknown;
  isCheckedInToQ700?: unknown;
  isCheckedInToManualTask?: unknown;
  checkIn?: CheckIn[];
}

export interface QfichajeResult {
  ok: boolean;
  /** Datos del fichaje cuando ok=true */
  fichaje?: Qfichaje;
  /** Mensaje del DMS cuando ok=false (cerrado, sin fichaje, idp inválido) */
  message?: string;
}

const QFICHAJE_CUSTOM_INTERFACE = JSON.stringify({
  interfaces: [
    "id",
    "checkIn.dateIn",
    "checkIn.timeIn",
    "checkIn.dateOut",
    "checkIn.timeOut",
    "isCheckedInToProject",
    "isCheckedInToQ700",
    "isCheckedInToManualTask",
    "isCheckInActive",
    "checkIn.id",
  ],
});
const DMS_TIMEOUT_MS = 60_000;

/**
 * Devuelve el último fichaje del empleado identificado por `idp`.
 * `idp` se inyecta en el header `headers`.
 */
export async function fetchQfichaje(idp: string): Promise<QfichajeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DMS_TIMEOUT_MS);

  const headersField = JSON.stringify({
    headers: { idp, profile: "App_qservers" },
  });

  try {
    const res = await fetch(config.dmsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        "access-token": config.dmsAccessToken,
        ClientId: config.dmsClientId,
        metododms: "GET.QFICHAJE",
        entidadDms: "CATALOGO",
        methodtype: config.dmsMethodType,
        servercode: config.dmsServerCode,
        headers: headersField,
        custominterface: QFICHAJE_CUSTOM_INTERFACE,
      },
      body: JSON.stringify({
        queryParams: { lastClockIn: true },
      }),
      signal: controller.signal,
    });

    const data = (await res.json().catch(() => null)) as
      | { procedures?: Qfichaje[]; message?: { errors?: Array<{ message?: string }> } }
      | null;

    if (data && Array.isArray(data.procedures) && data.procedures.length > 0) {
      return { ok: true, fichaje: data.procedures[0] };
    }

    // El DMS devuelve el detalle (cerrado / sin fichaje / idp inválido) en message.errors.
    const dmsMessage = data?.message?.errors?.[0]?.message;
    if (dmsMessage) {
      return { ok: false, message: dmsMessage };
    }

    if (!res.ok) {
      return { ok: false, message: `DMS error: ${res.status} ${res.statusText}` };
    }

    return { ok: false, message: "Sin datos de fichaje." };
  } finally {
    clearTimeout(timeout);
  }
}
