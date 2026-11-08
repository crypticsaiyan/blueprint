import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { CodeAnalysis, CodeModule, QueryUsage } from "../../../shared/code-types.js";
import type { SchemaSnapshot } from "../../../shared/schema-types.js";

const SOURCE = /\.(py|rb|go|java|kt|php|ex|exs|cs|rs|js|jsx|ts|tsx|mjs|scala|swift)$/;
const SKIP = new Set(["node_modules", "vendor", "dist", "build", "target", ".git", "venv", ".venv", "__pycache__", "data"]);

async function walk(dir: string, root: string, out: string[], depth = 0) {
  if (depth > 8 || out.length > 2000) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, out, depth + 1);
    else if (SOURCE.test(entry.name)) out.push(full);
  }
}

/** Fallback for unsupported languages: table names found as words. */
export async function analyzeTextSearch(repoPath: string, snapshot: SchemaSnapshot): Promise<CodeAnalysis> {
  const files: string[] = [];
  await walk(repoPath, repoPath, files);
  const modules: CodeModule[] = [];
  const usages: QueryUsage[] = [];
  for (const file of files) {
    if ((await stat(file)).size > 512 * 1024) continue;
    const rel = path.relative(repoPath, file).split(path.sep).join("/");
    const lines = (await readFile(file, "utf8")).split("\n");
    let found = false;
    lines.forEach((text, index) => {
      for (const table of snapshot.tables) {
        if (!new RegExp(`\\b${table.name}\\b`).test(text)) continue;
        found = true;
        const write = new RegExp(`\\b(insert\\s+into|update|delete\\s+from)\\s+"?${table.name}\\b`, "i").test(text);
        usages.push({
          id: `${rel}:${index + 1}:${table.name}:reference`,
          module: rel,
          function: "(text match)",
          line: index + 1,
          table: table.name,
          columns: table.columns.map((c) => c.name).filter((c) => new RegExp(`\\b${c}\\b`).test(text)),
          kind: write ? "write" : "read",
          operation: write ? "raw" : "reference",
          snippet: text.trim().slice(0, 180),
          approximate: true,
        });
      }
    });
    if (found) modules.push({ path: rel, label: rel, imports: [] });
  }
  return {
    adapter: "text-search",
    approximate: true,
    schemaFile: null,
    modules,
    usages,
    analyzedAt: new Date().toISOString(),
  };
}
