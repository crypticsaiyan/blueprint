import type { CodeAnalysis, QueryUsage, UsageOperation } from "../../../shared/code-types.js";
import type { SchemaSnapshot } from "../../../shared/schema-types.js";
import { argumentText, enclosingFunction, scanRepo } from "./pattern-scan.js";
import { findSupabaseTypes } from "./supabase-types.js";

// Supabase client repos: queries are `supabase.from("table").select(...)`
// chains. The table is a string, the columns sit in the select list, the
// written object's keys and filters like `.eq("col", v)`. Found by pattern,
// so results stay labeled approximate.

const METHODS: Record<string, UsageOperation> = {
  select: "select",
  insert: "insert",
  // An upsert inserts when the row is new, so it must set required columns.
  upsert: "insert",
  update: "update",
  delete: "delete",
};

const FROM = /\.\s*from\(\s*(["'`])([\w$]+)\1\s*\)/g;

export async function analyzeSupabaseJs(repoPath: string, snapshot: SchemaSnapshot): Promise<CodeAnalysis> {
  const tables = new Map(snapshot.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
  const { modules, usages } = await scanRepo(repoPath, /\.\s*from\(\s*["'`]/, (rel, lines) => {
    const found: QueryUsage[] = [];
    lines.forEach((line, index) => {
      for (const m of line.matchAll(FROM)) {
        // `supabase.schema("basejump").from("accounts")` reads basejump.accounts.
        const schema = `${lines[index - 1] ?? ""}\n${line.slice(0, m.index)}`.match(/\.\s*schema\(\s*(["'`])([\w$]+)\1\s*\)\s*$/)?.[2];
        const table = schema && schema !== "public" ? `${schema}.${m[2]!}` : m[2]!;
        const columns = tables.get(table);
        if (!columns) continue;
        // `supabase.storage.from("avatars")` names a bucket, not a table.
        const before = `${lines[index - 1] ?? ""}\n${line.slice(0, m.index)}`;
        if (/storage\s*$/.test(before)) continue;
        // The chain after .from(...): read up to the end of the statement.
        const start = m.index! + m[0].length;
        let chain = line.slice(start);
        for (let i = index + 1; i < Math.min(lines.length, index + 30) && !/;\s*$/.test(chain.trimEnd()); i++) {
          if (!/^\s*[.)\]}]/.test(lines[i]!) && !/[.(,{[]\s*$/.test(chain.trimEnd())) break;
          chain += `\n${lines[i]}`;
        }
        const method = chain.match(/^\s*\.\s*(select|insert|upsert|update|delete)\s*\(/)?.[1];
        const operation: UsageOperation = method ? METHODS[method]! : "reference";
        const used = new Set<string>();
        const callAt = method ? chain.indexOf("(") : -1;
        if (method) {
          const args = argumentText([chain], 0, callAt);
          if (method === "select") {
            const list = args.match(/^\(\s*(["'`])([\s\S]*?)\1/)?.[2] ?? "";
            for (const part of list.split(",")) {
              const name = part.trim().split(/[:(!\s]/)[0];
              if (name && columns.has(name)) used.add(name);
            }
          } else {
            // `key: value`, or the shorthand `{ key }`.
            for (const key of args.matchAll(/["']?([\w$]+)["']?\s*:|[{,]\s*([\w$]+)\s*(?=[,}])/g)) {
              const name = key[1] ?? key[2]!;
              if (columns.has(name)) used.add(name);
            }
          }
        }
        for (const f of chain.matchAll(/\.\s*(?:eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|match|order|filter)\(\s*(["'`])([\w$]+)\1/g)) {
          if (columns.has(f[2]!)) used.add(f[2]!);
        }
        found.push({
          id: `${rel}:${index + 1}:${table}:${operation}:${m.index}`,
          module: rel,
          function: enclosingFunction(lines, index),
          line: index + 1,
          table,
          columns: [...used],
          kind: operation === "select" || operation === "reference" ? "read" : "write",
          operation,
          snippet: line.trim().slice(0, 180),
          approximate: true,
        });
      }
    });
    return found;
  });
  const schemaFiles = await findSupabaseTypes(repoPath);
  return { adapter: "supabase-js", approximate: true, schemaFile: null, schemaFiles, modules, usages, analyzedAt: new Date().toISOString() };
}
