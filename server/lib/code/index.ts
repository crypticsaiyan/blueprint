import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CodeAnalysis } from "../../../shared/code-types.js";
import type { SchemaSnapshot } from "../../../shared/schema-types.js";
import { analyzePrisma, hasPrismaSchema } from "./prisma.js";
import { analyzeSupabaseJs } from "./supabase-js.js";
import { analyzeTextSearch } from "./text-search.js";
import { analyzeTypescriptDrizzle } from "./typescript-drizzle.js";

async function packageFiles(dir: string, depth: number, out: string[]) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === "package.json") out.push(full);
    else if (entry.isDirectory() && depth > 0) await packageFiles(full, depth - 1, out);
  }
}

/**
 * The code side sits behind an adapter. TypeScript + Drizzle repos get parsed
 * queries; Prisma model calls and supabase-js `.from()` chains are matched by
 * pattern; anything else falls back to text search. All but the first are
 * labeled approximate.
 * Monorepos count too: Drizzle often lives in a workspace package.
 */
export async function detectAdapter(repoPath: string): Promise<CodeAnalysis["adapter"]> {
  const files: string[] = [];
  await packageFiles(repoPath, 3, files);
  let prisma = false;
  let supabase = false;
  for (const file of files) {
    try {
      const pkg = JSON.parse(await readFile(file, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      if (deps["drizzle-orm"]) return "typescript-drizzle";
      if (deps["@prisma/client"] || deps.prisma) prisma = true;
      if (deps["@supabase/supabase-js"] || deps["@supabase/ssr"]) supabase = true;
    } catch {
      // Unreadable package.json: skip it.
    }
  }
  if (prisma && (await hasPrismaSchema(repoPath))) return "prisma";
  return supabase ? "supabase-js" : "text-search";
}

export async function analyzeCode(repoPath: string, snapshot: SchemaSnapshot): Promise<CodeAnalysis> {
  const adapter = await detectAdapter(repoPath);
  if (adapter === "typescript-drizzle") {
    const result = await analyzeTypescriptDrizzle(repoPath, snapshot);
    if (result.schemaFile) return result;
  }
  if (adapter === "prisma") {
    const result = await analyzePrisma(repoPath, snapshot);
    if (result.usages.length) return result;
  }
  if (adapter === "supabase-js") {
    const result = await analyzeSupabaseJs(repoPath, snapshot);
    if (result.usages.length) return result;
  }
  return analyzeTextSearch(repoPath, snapshot);
}
