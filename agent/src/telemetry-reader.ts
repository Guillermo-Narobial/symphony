import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export async function readTelemetry(limit: number): Promise<string[]> {
  try { return (await readFile(resolve(process.env.AGENT_TELEMETRY_FILE ?? "symphony-agent-telemetry.jsonl"), "utf8")).split(String.fromCharCode(10)).filter(Boolean).slice(-limit); } catch { return []; }
}
