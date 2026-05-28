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

// Mutaciones simples pero efectivas
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

function generateMutants(source: string, file: string): Mutant[] {
  const lines = source.split("\n");
  const mutants: Mutant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip imports, comments, decorators, specs
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

  // Limitar a 20 mutantes por archivo para no tardar horas
  return mutants.slice(0, 20);
}

async function testMutant(mutant: Mutant): Promise<boolean> {
  const filePath = resolve(WORK_DIR, mutant.file);
  const original = await readFile(filePath, "utf-8");
  const lines = original.split("\n");
  // Aplicar mutación
  lines[mutant.line - 1] = lines[mutant.line - 1].replace(mutant.original, mutant.mutated);
  await writeFile(filePath, lines.join("\n"));

  try {
    // Ejecutar tests relacionados
    const specFile = mutant.file.replace(/\.ts$/, ".spec.ts");
    await exec("npx", ["vitest", "run", "--config", "vitest.stryker.config.ts", specFile], {
      cwd: WORK_DIR,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    // Tests pasaron con mutante → mutante sobrevivió (test débil)
    return true;
  } catch {
    // Tests fallaron → mutante detectado (test robusto)
    return false;
  } finally {
    // Restaurar archivo original
    await writeFile(filePath, original);
  }
}

async function findSpecFiles(): Promise<string[]> {
  const { stdout } = await exec("find", ["src/app", "-name", "*.spec.ts", "-not", "-path", "*/node_modules/*"], { cwd: WORK_DIR });
  return stdout.trim().split("\n").filter(Boolean);
}

async function processFile(specFile: string): Promise<FileResult | null> {
  const sourceFile = specFile.replace(".spec.ts", ".ts");
  const sourcePath = resolve(WORK_DIR, sourceFile);

  let source: string;
  try { source = await readFile(sourcePath, "utf-8"); } catch { return null; }

  const mutants = generateMutants(source, sourceFile);
  if (mutants.length === 0) return null;

  console.log(`  🧬 ${sourceFile}: ${mutants.length} mutantes...`);

  let survived = 0;
  const survivors: Mutant[] = [];

  for (const mutant of mutants) {
    const didSurvive = await testMutant(mutant);
    if (didSurvive) {
      survived++;
      survivors.push(mutant);
    }
  }

  const score = Math.round(((mutants.length - survived) / mutants.length) * 100);
  return { file: sourceFile, total: mutants.length, survived, score, survivors };
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
  console.log("🧬 Mutation testing periódico — inicio");

  // Sync repo
  await exec("git", ["fetch", "origin"], { cwd: WORK_DIR });
  await exec("git", ["checkout", "hotfix-master"], { cwd: WORK_DIR });
  await exec("git", ["pull", "origin", "hotfix-master", "--ff-only"], { cwd: WORK_DIR });

  // Encontrar archivos con specs
  const specFiles = await findSpecFiles();
  console.log(`📋 ${specFiles.length} archivos con tests encontrados`);

  const weakFiles: FileResult[] = [];

  for (let i = 0; i < specFiles.length; i++) {
    const spec = specFiles[i];
    console.log(`\n📂 [${i + 1}/${specFiles.length}] ${spec}`);
    const result = await processFile(spec);
    if (result && result.survived >= SURVIVAL_THRESHOLD) {
      weakFiles.push(result);
      console.log(`  ⚠️  ${result.file}: score ${result.score}% (${result.survived} sobrevivieron)`);
    }
  }

  weakFiles.sort((a, b) => a.score - b.score);

  // Guardar reporte JSON
  const reportPath = resolve(WORK_DIR, "reports/mutation/mutation.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ date: new Date().toISOString(), total: specFiles.length, weak: weakFiles.length, results: weakFiles }, null, 2));
  console.log(`💾 Reporte guardado en ${reportPath}`);

  console.log(`\n📊 ${weakFiles.length} archivos con tests débiles (≥${SURVIVAL_THRESHOLD} mutantes)`);

  if (weakFiles.length === 0) {
    console.log("🎉 Todos los tests son robustos");
    await notifyEmail(
      `🧬 [Symphony] Mutation testing completado — ${new Date().toISOString().slice(0, 10)}`,
      `<h2>🧬 Mutation testing completado</h2><p>🎉 Todos los tests son robustos. ${specFiles.length} archivos analizados, 0 débiles.</p>`
    );
    return;
  }

  await createIssues(weakFiles);

  const summary = weakFiles.slice(0, 10).map(r => `<li><code>${r.file}</code> — ${r.score}% (${r.survived} mutantes sobrevivieron)</li>`).join("");
  await notifyEmail(
    `🧬 [Symphony] Mutation testing — ${weakFiles.length} archivos débiles`,
    `<h2>🧬 Mutation testing completado</h2><p>${specFiles.length} archivos analizados, ${weakFiles.length} con tests débiles:</p><ul>${summary}</ul>`
  );

  console.log("🏁 Mutation testing completado");
}

main().catch((err) => {
  console.error("❌ Error en mutator:", err);
  process.exit(1);
});
