import { config } from "./config.js";

export async function fetchTasks(): Promise<unknown[]> {
  const res = await fetch(config.dmsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "*/*",
      "access-token": config.dmsAccessToken,
      "ClientId": config.dmsClientId,
      "metododms": config.dmsMetodoDms,
      "entidadDms": config.dmsEntidad,
      "methodtype": config.dmsMethodType,
      "servercode": config.dmsServerCode,
      "headers": config.dmsHeaders,
      "custominterface": config.dmsCustomInterface,
    },
    body: JSON.stringify({
      queryParams: {
        searchValue: config.dmsSearchValue,
        isOpened: config.dmsIsOpened === "true",
      },
    }),
  });

  if (!res.ok) throw new Error(`DMS error: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.procedures) ? data.procedures : [];
}
