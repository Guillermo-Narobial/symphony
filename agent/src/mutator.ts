import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { notifyEmail } from "./notifier-email.js";

const exec = promisify(execFile);

const REPO = config.repo;
const LABEL = "audit:weak-test";
const ASSIGNEE = config.rejectAssignee;
const WORK_DIR = resolve(config.frontendRepoDir);
const SURVIVAL_THRESHOLD = 3;
const CONCURRENCY = 4;
const PROGRESS_PATH = process.env.MUTATOR_PROGRESS_PATH;

interface Mutant {
  file: string;
  line: number;
  original: string;
  mutated: string;
  type: string;
}

interface FileResult {
  file: string;
  total: number;
  survived: number;
  score: number;
  survivors: Mutant[];
}

interface SkipSpec {
  spec: string;
  code: string;
  reason: string;
}

interface ProgressState {
  startedAt: string;
  updatedAt: string;
  workDir: string;
  totalSpecs: number;
  processedSpecs: string[];
  weakFiles: FileResult[];
  borderlineFiles: FileResult[];
  skippedSpecs: SkipSpec[];
  noMutantsSpecs: string[];
  currentSpecs: string[];
}

type MutantTestResult =
  | { kind: "survived" | "killed" }
  | { kind: "skip"; code: string; reason: string };

type ProcessResult =
  | { kind: "result"; result: FileResult }
  | { kind: "no-mutants" }
  | { kind: "skipped"; code: string; reason: string };

const MUTATIONS: Array<{ type: string; pattern: RegExp; replace: string }> = [
  { type: "BooleanNegate", pattern: /\btrue\b/g, replace: "false" },
  { type: "BooleanNegate", pattern: /\bfalse\b/g, replace: "true" },
  { type: "ConditionalNegate", pattern: /===/g, replace: "!==" },
  { type: "ConditionalNegate", pattern: /!==/g, replace: "===" },
  { type: "ArithmeticReplace", pattern: /\+(?!=)/g, replace: "-" },
  { type: "RemoveReturn", pattern: /return\s+([^;]+);/g, replace: "return undefined as any;" },
  { type: "EmptyString", pattern: /'[^']+'/g, replace: "''" },
  { type: "ZeroNumber", pattern: /(?<![a-zA-Z_$])\d+(?!\d*[a-zA-Z_$])/g, replace: "0" },
];

function uniqueByFile(results: FileResult[]): FileResult[] {
  const byFile = new Map<string, FileResult>();
  for (const result of results) byFile.set(result.file, result);
  return [...byFile.values()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueSkips(skips: SkipSpec[]): SkipSpec[] {
  const bySpec = new Map<string, SkipSpec>();
  for (const skip of skips) bySpec.set(skip.spec, skip);
  return [...bySpec.values()].sort((a, b) => a.spec.localeCompare(b.spec));
}

async function loadProgress(): Promise<ProgressState | null> {
  if (!PROGRESS_PATH) return null;
  try {
    const raw = await readFile(PROGRESS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as ProgressState;
    if (parsed.workDir !== WORK_DIR) return null;
    return {
      ...parsed,
      processedSpecs: parsed.processedSpecs ?? [],
      weakFiles: parsed.weakFiles ?? [],
      borderlineFiles: parsed.borderlineFiles ?? [],
      skippedSpecs: parsed.skippedSpecs ?? [],
      noMutantsSpecs: parsed.noMutantsSpecs ?? [],
      currentSpecs: parsed.currentSpecs ?? [],
    };
  } catch {
    return null;
  }
}

async function saveProgress(progress: ProgressState): Promise<void> {
  if (!PROGRESS_PATH) return;
  await mkdir(dirname(PROGRESS_PATH), { recursive: true });
  progress.updatedAt = new Date().toISOString();
  progress.weakFiles = uniqueByFile(progress.weakFiles).sort((a, b) => a.score - b.score);
  progress.borderlineFiles = uniqueByFile(progress.borderlineFiles).sort((a, b) => a.score - b.score);
  progress.skippedSpecs = uniqueSkips(progress.skippedSpecs);
  progress.noMutantsSpecs = uniqueStrings(progress.noMutantsSpecs);
  await writeFile(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

function generateMutants(source: string, file: string): Mutant[] {
  const lines = source.split("\n");
  const mutants: Mutant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(import|\/\/|\/\*|\*|@)/.test(line)) continue;
    if (/\.spec\./.test(file)) continue;

    for (const mut of MUTATIONS) {
      const matches = line.matchAll(mut.pattern);
      for (const match of matches) {
        if (match.index === undefined) continue;
        const mutated = line.slice(0, match.index) + mut.replace + line.slice(match.index + match[0].length);
        if (mutated !== line) {
          mutants.push({ file, line: i + 1, original: line.trim(), mutated: mutated.trim(), type: mut.type });
        }
      }
    }
  }

  return mutants.slice(0, 20);
}

async function testMutant(mutant: Mutant): Promise<MutantTestResult> {
  const filePath = resolve(WORK_DIR, mutant.file);
  let original: string;
  try {
    original = await readFile(filePath, "utf-8");
  } catch (error) {
    return {
      kind: "skip",
      code: "mutant-read-error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const lines = original.split("\n");
  lines[mutant.line - 1] = lines[mutant.line - 1].replace(mutant.original, mutant.mutated);
  try {
    await writeFile(filePath, lines.join("\n"));
  } catch (error) {
    return {
      kind: "skip",
      code: "write-mutant-error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let outcome: MutantTestResult;
  try {
    const specFile = mutant.file.replace(/\.ts$/, ".spec.ts");
    await exec("npx", ["vitest", "run", "--config", "vitest.config.ts", specFile], {
      cwd: WORK_DIR,
      timeout: 90_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    outcome = { kind: "survived" };
  } catch {
    outcome = { kind: "killed" };
  } finally {
    try {
      await writeFile(filePath, original);
    } catch (error) {
      outcome = {
        kind: "skip",
        code: "restore-source-error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return outcome;
}

async function findSpecFiles(): Promise<string[]> {
  const { stdout } = await exec("find", ["src/app", "-name", "*.spec.ts", "-not", "-path", "*/node_modules/*"], { cwd: WORK_DIR });
  return stdout.trim().split("\n").filter(Boolean);
}

async function processFile(specFile: string): Promise<ProcessResult> {
  const sourceFile = specFile.replace(".spec.ts", ".ts");
  const sourcePath = resolve(WORK_DIR, sourceFile);

  let source: string;
  try {
    source = await readFile(sourcePath, "utf-8");
  } catch (error) {
    return {
      kind: "skipped",
      code: "missing-source-file",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const mutants = generateMutants(source, sourceFile);
  if (mutants.length === 0) return { kind: "no-mutants" };

  console.log(`  🧬 ${sourceFile}: ${mutants.length} mutantes...`);

  let survived = 0;
  const survivors: Mutant[] = [];

  for (const mutant of mutants) {
    const mutantResult = await testMutant(mutant);
    if (mutantResult.kind === "skip") {
      return { kind: "skipped", code: mutantResult.code, reason: mutantResult.reason };
    }
    if (mutantResult.kind === "survived") {
      survived++;
      survivors.push(mutant);
    }
  }

  const score = Math.round(((mutants.length - survived) / mutants.length) * 100);
  return { kind: "result", result: { file: sourceFile, total: mutants.length, survived, score, survivors } };
}

async function runPool(specFiles: string[], progress: ProgressState): Promise<{ weakFiles: FileResult[]; borderlineFiles: FileResult[] }> {
  const weakFiles = [...progress.weakFiles];
  const borderlineFiles = [...progress.borderlineFiles];
  const processed = new Set(progress.processedSpecs);
  const pendingSpecs = specFiles.filter((spec) => !processed.has(spec));
  let idx = 0;

  async function markCurrent(spec: string, active: boolean): Promise<void> {
    const current = new Set(progress.currentSpecs);
    if (active) current.add(spec);
    else current.delete(spec);
    progress.currentSpecs = [...current].sort();
    await saveProgress(progress);
  }

  async function worker(): Promise<void> {
    while (idx < pendingSpecs.length) {
      const i = idx++;
      const spec = pendingSpecs[i];
      const absoluteIndex = specFiles.indexOf(spec) + 1;

      console.log(`\n📂 [${absoluteIndex}/${specFiles.length}] ${spec}`);
      await markCurrent(spec, true);

      try {
        const result = await processFile(spec);
        if (result.kind === "result" && result.result.survived >= SURVIVAL_THRESHOLD) {
          weakFiles.push(result.result);
          progress.weakFiles = uniqueByFile(weakFiles);
          console.log(`  ⚠️  ${result.result.file}: score ${result.result.score}% (${result.result.survived} sobrevivieron)`);
        } else if (result.kind === "result" && result.result.survived > 0) {
          borderlineFiles.push(result.result);
          progress.borderlineFiles = uniqueByFile(borderlineFiles);
          console.log(`  ℹ️  ${result.result.file}: ${result.result.survived} mutantes sobrevivieron pero queda bajo el umbral`);
        } else if (result.kind === "no-mutants") {
          progress.noMutantsSpecs.push(spec);
          console.log(`  ℹ️  ${spec}: sin mutantes generados`);
        } else if (result.kind === "skipped") {
          progress.skippedSpecs.push({ spec, code: result.code, reason: result.reason });
          console.log(`  ⏭️  Skip ${spec}: [${result.code}] ${result.reason}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        progress.skippedSpecs.push({ spec, code: "processing-error", reason: message });
        console.log(`  ⏭️  Error procesando ${spec}, skip: ${message}`);
      } finally {
        processed.add(spec);
        progress.processedSpecs = [...processed].sort();
        await markCurrent(spec, false);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return {
    weakFiles: uniqueByFile(weakFiles).sort((a, b) => a.score - b.score),
    borderlineFiles: uniqueByFile(borderlineFiles).sort((a, b) => a.score - b.score),
  };
}

async function ensureLabel(): Promise<void> {
  try {
    await exec("gh", ["label", "create", LABEL, "-R", REPO, "--color", "FBCA04", "--description", "Test débil detectado por mutation testing"], { timeout: 10_000 });
  } catch {}
}

async function issueExists(title: string): Promise<boolean> {
  const { stdout } = await exec("gh", ["issue", "list", "-R", REPO, "--state", "open", "--search", `"${title}" in:title`, "--json", "number", "--limit", "3"]);
  return JSON.parse(stdout).length > 0;
}

async function createIssues(results: FileResult[]): Promise<void> {
  await ensureLabel();
  for (const r of results) {
    const shortFile = r.file.replace(/^src\/app\//, "");
    const title = `[mutation] Tests débiles en ${shortFile} (${r.score}%)`;
    if (await issueExists(title)) { console.log(`⏭️  Ya existe: ${title}`); continue; }

    const examples = r.survivors.slice(0, 8).map(m => `- L${m.line}: \`${m.type}\`\n  - Original: \`${m.original.slice(0, 120)}\`\n  - Mutado: \`${m.mutated.slice(0, 120)}\``).join("\n");
    const specFile = r.file.replace(/\.ts$/, ".spec.ts");
    const body = `## 🧬 Mutation testing — tests débiles\n\n**Archivo productivo:** \`${r.file}\`\n**Spec esperado:** \`${specFile}\`\n**Score:** ${r.score}% (${r.survived}/${r.total} mutantes sobrevivieron)\n\n### Mutantes no detectados\n\n${examples}\n\n### Guía de solución para el agente\n\n1. Abre \`${r.file}\` y \`${specFile}\`. Entiende qué contrato público protege cada línea mutada.\n2. Para cada mutante sobreviviente, añade una assertion que fallaría si el código quedara como la versión mutada.\n3. Prioriza tests de comportamiento observable: inputs/outputs, DOM renderizado, llamadas a servicios, guards, routing y efectos laterales.\n4. Evita tests frágiles que solo comprueben implementación interna salvo metadatos Angular o constantes públicas que sean contrato real.\n5. Ejecuta primero el spec afectado con \`npm run test:unit:staged -- ${specFile}\` si aplica, luego \`npm run test:unit:staged\`.\n6. No cambies código productivo salvo que descubras un bug real; el objetivo principal es fortalecer tests.\n\n### Criterio de aceptación\n\n- Los mutantes listados quedan cubiertos por nuevas assertions.\n- El spec relacionado pasa.\n- Si se toca i18n o componentes visuales, se respetan las reglas de \`AGENTS.md\` e \`INSTRUCTIONS.md\`.\n\n---\n_Generado por symphony-agent mutator._`;

    const { stdout } = await exec("gh", ["issue", "create", "-R", REPO, "--title", title, "--body", body, "--label", LABEL, "--assignee", ASSIGNEE]);
    console.log(`✅ Creada: ${stdout.trim()}`);
  }
}

async function main(): Promise<void> {
  console.log("🧬 Mutation testing — inicio (4 workers)");

  await exec("git", ["fetch", "origin"], { cwd: WORK_DIR });
  await exec("git", ["checkout", "hotfix-master"], { cwd: WORK_DIR });
  await exec("git", ["reset", "--hard", "HEAD"], { cwd: WORK_DIR });
  await exec("git", ["clean", "-fd"], { cwd: WORK_DIR });
  await exec("git", ["pull", "origin", "hotfix-master", "--ff-only"], { cwd: WORK_DIR });

  const specFiles = await findSpecFiles();
  const existingProgress = await loadProgress();
  const progress: ProgressState = existingProgress ?? {
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workDir: WORK_DIR,
    totalSpecs: specFiles.length,
    processedSpecs: [],
    weakFiles: [],
    borderlineFiles: [],
    skippedSpecs: [],
    noMutantsSpecs: [],
    currentSpecs: [],
  };

  progress.totalSpecs = specFiles.length;
  progress.currentSpecs = [];
  await saveProgress(progress);

  const completed = progress.processedSpecs.length;
  console.log(`📋 ${specFiles.length} archivos con tests encontrados`);
  if (completed > 0) {
    console.log(`♻️  Reanudando desde checkpoint: ${completed}/${specFiles.length} specs ya procesados`);
  }

  const { weakFiles, borderlineFiles } = await runPool(specFiles, progress);
  progress.weakFiles = weakFiles;
  progress.borderlineFiles = borderlineFiles;
  progress.currentSpecs = [];
  await saveProgress(progress);

  const reportPath = resolve(WORK_DIR, "reports/mutation/mutation.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({
    date: new Date().toISOString(),
    total: specFiles.length,
    weak: weakFiles.length,
    borderline: borderlineFiles.length,
    noMutants: progress.noMutantsSpecs.length,
    skipped: progress.skippedSpecs,
    results: weakFiles,
    borderlineResults: borderlineFiles,
    noMutantsSpecs: progress.noMutantsSpecs,
  }, null, 2));
  console.log(`💾 Reporte guardado en ${reportPath}`);

  console.log(`\n📊 ${weakFiles.length} archivos con tests débiles (≥${SURVIVAL_THRESHOLD} mutantes)`);
  if (borderlineFiles.length > 0) {
    console.log(`ℹ️  ${borderlineFiles.length} archivos tienen 1-${SURVIVAL_THRESHOLD - 1} mutantes sobrevivientes`);
  }
  if (progress.noMutantsSpecs.length > 0) {
    console.log(`ℹ️  ${progress.noMutantsSpecs.length} specs no generaron mutantes`);
  }
  if (progress.skippedSpecs.length > 0) {
    console.log(`⏭️  ${progress.skippedSpecs.length} specs se marcaron como skip por error`);
  }

  if (weakFiles.length === 0 && borderlineFiles.length === 0 && progress.skippedSpecs.length === 0) {
    console.log("🎉 No se detectaron tests débiles ni ejecuciones omitidas");
    await notifyEmail(
      `🧬 [Symphony] Mutation testing completado — ${new Date().toISOString().slice(0, 10)}`,
      `<h2>🧬 Mutation testing completado</h2><p>No se detectaron archivos débiles ni specs omitidos.</p><p><strong>Analizados:</strong> ${specFiles.length}</p><p><strong>Borderline:</strong> ${borderlineFiles.length}</p><p><strong>Sin mutantes:</strong> ${progress.noMutantsSpecs.length}</p>`
    );
    return;
  }

  if (weakFiles.length > 0) {
    await createIssues(weakFiles);
  }

  const summary = weakFiles.slice(0, 10).map(r => `<li><code>${r.file}</code> — ${r.score}% (${r.survived} mutantes sobrevivieron)</li>`).join("");
  const borderlineSummary = borderlineFiles.slice(0, 10).map(r => `<li><code>${r.file}</code> — ${r.survived} mutantes sobrevivieron</li>`).join("");
  const skipSummary = progress.skippedSpecs.slice(0, 10).map(s => `<li><code>${s.spec}</code> — [${s.code}] ${s.reason}</li>`).join("");
  await notifyEmail(
    `🧬 [Symphony] Mutation testing — ${weakFiles.length} débiles, ${borderlineFiles.length} borderline, ${progress.skippedSpecs.length} skip`,
    `<h2>🧬 Mutation testing completado</h2><p><strong>Analizados:</strong> ${specFiles.length}</p><p><strong>Débiles:</strong> ${weakFiles.length}</p><p><strong>Borderline:</strong> ${borderlineFiles.length}</p><p><strong>Sin mutantes:</strong> ${progress.noMutantsSpecs.length}</p><p><strong>Skip:</strong> ${progress.skippedSpecs.length}</p>${summary ? `<h3>Débiles</h3><ul>${summary}</ul>` : ""}${borderlineSummary ? `<h3>Borderline</h3><ul>${borderlineSummary}</ul>` : ""}${skipSummary ? `<h3>Skip</h3><ul>${skipSummary}</ul>` : ""}`
  );

  console.log("🏁 Mutation testing completado");
}

main().catch((err) => {
  console.error("❌ Error en mutator:", err);
  process.exit(1);
});
