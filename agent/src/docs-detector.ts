import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
const exec = promisify(execFile);
const repoDir = resolve(config.frontendRepoDir);
const branch = "hotfix-master";
const label = "docs:jsdoc";
const NL = String.fromCharCode(10);
async function git(cwd: string, ...args: string[]): Promise<string> { const { stdout } = await exec("git", args, { cwd, timeout: 300000, maxBuffer: 20 * 1024 * 1024, env: process.env }); return stdout.trim(); }
function hasJSDocAbove(lines: string[], index: number): boolean { for (let i = index - 1; i >= 0; i -= 1) { const line = lines[i].trim(); if (line) return line.endsWith("*/"); } return false; }
async function main(): Promise<void> {
 const root = await mkdtemp(join(tmpdir(), "symphony-docs-detector-")); const workDir = join(root, "repo");
 try {
  await exec("git", ["clone", "--no-local", "--branch", branch, "--single-branch", repoDir, workDir], { timeout: 300000, env: process.env });
  const raw = await git(workDir, "log", "--since=7.days", "--diff-filter=AM", "--name-only", "--pretty=format:");
  const files = raw.split(NL).filter((file) => file.startsWith("src/app/") && file.endsWith(".ts") && !file.includes(".spec.")); const findings: string[] = [];
  for (const file of [...new Set(files)]) { let lines: string[]; try { lines = (await readFile(resolve(workDir, file), "utf8")).split(NL); } catch { continue; } lines.forEach((line, index) => { if (/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const)\s+\w+/.test(line) && !hasJSDocAbove(lines, index)) findings.push("- " + file + ":" + (index + 1) + " — " + line.trim()); }); }
  if (!findings.length) { console.log("✅ Detector docs: no hay declaraciones sin JSDoc"); return; }
  const existing = await exec("gh", ["issue", "list", "-R", config.repo, "--state", "open", "--label", label, "--search", "in:title declaraciones sin JSDoc", "--json", "number", "--jq", ".[0].number"], { timeout: 60000, env: process.env });
  if (existing.stdout.trim()) { console.log("↩️ Issue docs ya abierta: #" + existing.stdout.trim()); return; }
  const body = ["## Detector de documentación", "", "Se detectaron declaraciones públicas/exportadas sin JSDoc en `" + branch + "` durante los últimos 7 días.", "", findings.slice(0, 100).join(NL), "", "_Este detector no modifica código ni ejecuta agentes interactivos._"].join(NL);
  const { stdout } = await exec("gh", ["issue", "create", "-R", config.repo, "--title", "docs: declaraciones sin JSDoc (" + new Date().toISOString().slice(0, 10) + ")", "--body", body, "--label", label, "--assignee", config.rejectAssignee], { timeout: 60000, env: process.env }); console.log("🎫 Issue docs creada: " + stdout.trim());
 } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error("❌ Error en docs-detector:", error); process.exit(1); });
