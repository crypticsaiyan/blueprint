import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CodeAnalysis } from "../../../shared/code-types.js";
import type { SchemaSnapshot } from "../../../shared/schema-types.js";
import { analyzeTextSearch } from "./text-search.js";
import { analyzeTypescriptDrizzle } from "./typescript-drizzle.js";

/**
 * The code side sits behind an adapter. TypeScript + Drizzle repos get parsed
 * queries; anything else falls back to text search, labeled approximate.
 */
export async function detectAdapter(repoPath: string): Promise<CodeAnalysis["adapter"]> {
  try {
    const pkg = JSON.parse(await readFile(path.join(repoPath, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["drizzle-orm"]) return "typescript-drizzle";
  } catch {
    // No package.json: not a Node project.
  }
  return "text-search";
}

export async function analyzeCode(repoPath: string, snapshot: SchemaSnapshot): Promise<CodeAnalysis> {
  const adapter = await detectAdapter(repoPath);
  if (adapter === "typescript-drizzle") {
    const result = await analyzeTypescriptDrizzle(repoPath, snapshot);
    if (result.schemaFile) return result;
  }
  return analyzeTextSearch(repoPath, snapshot);
}
