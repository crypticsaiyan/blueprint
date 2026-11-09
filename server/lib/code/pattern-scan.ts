import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { CodeModule, QueryUsage } from "../../../shared/code-types.js";

// Shared by the adapters that find queries by pattern (Prisma, supabase-js):
// walking the repo, reading a call's arguments, naming the enclosing function
// and linking the modules that query the database by their relative imports.

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const SKIP = new Set(["node_modules", "dist", "build", ".next", ".output", "coverage", "generated", "data"]);

export async function walk(dir: string, match: (name: string) => boolean, out: string[], depth: number) {
  if (depth < 0 || out.length > 50_000) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, match, out, depth - 1);
    else if (match(entry.name)) out.push(full);
  }
}

/** Text from `column` of line `index` to the bracket that closes the first one opened. */
export function argumentText(lines: string[], index: number, column: number) {
  let depth = 0;
  let opened = false;
  let text = "";
  for (let i = index; i < Math.min(lines.length, index + 60); i++) {
    const line = i === index ? lines[i]!.slice(column) : lines[i]!;
    for (const ch of line) {
      if (ch === "(" || ch === "{" || ch === "[") {
        depth++;
        opened = true;
      } else if (ch === ")" || ch === "}" || ch === "]") depth--;
      text += ch;
      if (opened && depth <= 0) return text;
    }
    text += "\n";
  }
  return text;
}

const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "function"]);

/** Name of the function a line sits in: the nearest declaration above it. */
export function enclosingFunction(lines: string[], index: number) {
  for (let i = index; i >= Math.max(0, index - 200); i--) {
    const line = lines[i]!;
    const m =
      line.match(/function\s*\*?\s*(\w+)/) ??
      line.match(/(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:\w+\()?(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/) ??
      line.match(/^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/) ??
      line.match(/^\s*(\w+)\s*:\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/) ??
      line.match(/^\s*(\w+)\s*:\s*(?:async\s+)?function\b/) ??
      // tRPC routers: `createPoll: protectedProcedure.input(...).mutation(...)`.
      line.match(/^\s*(\w+)\s*:\s*[\w$.]*[pP]rocedure\b/);
    if (m && !NOT_NAMES.has(m[1]!)) return m[1]!;
  }
  return "(module)";
}

function resolveImport(from: string, spec: string, known: Set<string>) {
  const base = path.posix.join(path.posix.dirname(from), spec);
  const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
  const candidates = [".ts", ".tsx", ".js", ".jsx", ".mts", "/index.ts", "/index.tsx", "/index.js"].map((ext) => stem + ext);
  return [base, ...candidates].find((c) => known.has(c)) ?? null;
}

/**
 * Runs `scan` over every source file; files with usages become modules, linked
 * by the relative imports between them.
 */
export async function scanRepo(
  repoPath: string,
  quick: RegExp,
  scan: (rel: string, lines: string[]) => QueryUsage[],
): Promise<{ modules: CodeModule[]; usages: QueryUsage[] }> {
  const files: string[] = [];
  await walk(repoPath, (name) => SOURCE.test(name) && !name.endsWith(".d.ts"), files, 12);
  const usages: QueryUsage[] = [];
  const imports = new Map<string, { spec: string; line: number }[]>();
  for (const file of files) {
    if ((await stat(file)).size > 512 * 1024) continue;
    const text = await readFile(file, "utf8");
    if (!quick.test(text)) continue;
    const rel = path.relative(repoPath, file).split(path.sep).join("/");
    const lines = text.split("\n");
    const found = scan(rel, lines);
    if (!found.length) continue;
    usages.push(...found);
    imports.set(
      rel,
      lines.flatMap((line, index) =>
        [...line.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g)].map((m) => ({ spec: m[1]!, line: index + 1 })),
      ),
    );
  }
  const known = new Set(imports.keys());
  const modules: CodeModule[] = [...imports].map(([rel, specs]) => ({
    path: rel,
    label: rel,
    imports: specs
      .map((s) => ({ path: resolveImport(rel, s.spec, known), line: s.line }))
      .filter((s): s is { path: string; line: number } => s.path !== null && s.path !== rel),
  }));
  return { modules: modules.sort((a, b) => a.path.localeCompare(b.path)), usages };
}
