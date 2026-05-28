import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "./config.js";

const DECISIONS_DIR = resolve(config.reposDir, "narobial-changelog", "decisiones", "frontend");

interface Decision {
  file: string;
  title: string;
  content: string;
  tokens: string[];
}

let index: Decision[] | null = null;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-záéíóúñü0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function score(query: string[], doc: Decision): number {
  let s = 0;
  for (const q of query) {
    for (const t of doc.tokens) {
      if (t === q) s += 3;
      else if (t.includes(q) || q.includes(t)) s += 1;
    }
  }
  return s;
}

async function loadIndex(): Promise<Decision[]> {
  if (index) return index;

  const files = await readdir(DECISIONS_DIR).catch(() => [] as string[]);
  index = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const content = await readFile(resolve(DECISIONS_DIR, file), "utf-8");
    const titleMatch = content.match(/^#\s+(.+)/m);
    index.push({
      file,
      title: titleMatch?.[1] || file,
      content,
      tokens: tokenize(content),
    });
  }

  return index;
}

export async function searchKnowledgeBase(issueTitle: string, issueBody: string, limit = 3): Promise<string> {
  const decisions = await loadIndex();
  if (decisions.length === 0) return "";

  const query = tokenize(`${issueTitle} ${issueBody}`);
  if (query.length === 0) return "";

  const scored = decisions
    .map((d) => ({ decision: d, score: score(query, d) }))
    .filter((s) => s.score > 5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) return "";

  const sections = scored.map((s) => {
    // Extraer solo las secciones útiles (problema, causa raíz, solución)
    const relevant = s.decision.content
      .replace(/## Verificado en[\s\S]*$/, "")
      .replace(/## Dependencias[\s\S]*?(?=##|$)/, "")
      .trim();
    return `### ${s.decision.title}\n\n${relevant}`;
  });

  return `## 📚 Resoluciones similares del historial\n\nSe encontraron ${scored.length} incidencias similares resueltas anteriormente. Úsalas como referencia:\n\n${sections.join("\n\n---\n\n")}`;
}
