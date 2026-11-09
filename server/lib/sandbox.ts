import { readFile } from "node:fs/promises";

import { PGlite, type PGliteInterface } from "@electric-sql/pglite";

import { splitStatements } from "./sql-statements.js";
import { MIGRATION_BOUNDARY, needsSupabase, SUPABASE_PRELUDE } from "./schema-source.js";

// One in-memory Postgres per project holds the imported sample data. It is
// never written to: previews read it, rehearsals run on clones of it.
const sources = new Map<string, Promise<PGlite>>();

// Postgres extensions PGlite ships, by the name CREATE EXTENSION uses.
const CONTRIB: Record<string, string> = {
  "uuid-ossp": "uuid_ossp",
  pgcrypto: "pgcrypto",
  citext: "citext",
  hstore: "hstore",
  ltree: "ltree",
  pg_trgm: "pg_trgm",
  fuzzystrmatch: "fuzzystrmatch",
  unaccent: "unaccent",
  cube: "cube",
  earthdistance: "earthdistance",
  btree_gin: "btree_gin",
  btree_gist: "btree_gist",
  intarray: "intarray",
  isn: "isn",
  lo: "lo",
  seg: "seg",
  tablefunc: "tablefunc",
  tcn: "tcn",
  bloom: "bloom",
  moddatetime: "moddatetime",
};

/** Loads the extensions a dump asks for; names the ones the sandbox lacks. */
async function extensionsFor(sql: string) {
  const wanted = new Set<string>();
  for (const m of sql.matchAll(/create\s+extension\s+(?:if\s+not\s+exists\s+)?"?([\w-]+)"?/gi)) wanted.add(m[1]!.toLowerCase());
  const extensions: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const name of wanted) {
    if (name === "plpgsql") continue;
    if (name === "vector") {
      extensions.vector = (await import("@electric-sql/pglite-pgvector")).vector;
      continue;
    }
    const module = CONTRIB[name];
    if (!module) {
      missing.push(name);
      continue;
    }
    const loaded = (await import(`@electric-sql/pglite/contrib/${module}`)) as Record<string, unknown>;
    extensions[module] = loaded[module];
  }
  return { extensions, missing };
}

export interface LoadReport {
  /** Extensions the SQL asks for that PGlite does not ship. */
  missing: string[];
  /** Statements that failed because of them, and the tables those created. */
  skipped: number;
  skippedTables: string[];
}

const reports = new WeakMap<PGlite, LoadReport>();

/** What a load had to leave out, if anything. */
export const loadReport = (pg: PGlite): LoadReport | undefined => reports.get(pg);

/**
 * Loads SQL into a fresh database. Supabase SQL gets its platform stand-ins.
 * When an extension is missing, statements run one by one and the ones that
 * fail are skipped, so the rest of the schema still maps and rehearses.
 */
export async function loadSql(text: string): Promise<PGlite> {
  const sql = needsSupabase(text) ? `${SUPABASE_PRELUDE}\n${text}` : text;
  const { extensions, missing } = await extensionsFor(sql);
  const pg = new PGlite({ extensions: extensions as never });
  try {
    if (!missing.length) {
      for (const part of sql.split(MIGRATION_BOUNDARY)) await pg.exec(part);
      return pg;
    }
    const report: LoadReport = { missing, skipped: 0, skippedTables: [] };
    for (const { body } of splitStatements(sql).statements) {
      // One failed statement would abort an explicit transaction and take
      // every later statement with it, so each runs on its own.
      if (/^(begin|commit|rollback|start\s+transaction)\b/i.test(body.trim())) continue;
      try {
        await pg.exec(body);
      } catch {
        report.skipped += 1;
        const table = body.match(/^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([\w$]+)"?/i)?.[1];
        if (table) report.skippedTables.push(table);
      }
    }
    reports.set(pg, report);
    return pg;
  } catch (error) {
    await pg.close();
    throw error;
  }
}

async function load(dumpPath: string): Promise<PGlite> {
  return loadSql(await readFile(dumpPath, "utf8"));
}

export function sourceDb(projectId: string, dumpPath: string): Promise<PGlite> {
  let pending = sources.get(projectId);
  if (!pending) {
    pending = load(dumpPath);
    sources.set(projectId, pending);
    pending.catch(() => sources.delete(projectId));
  }
  return pending;
}

/** Loads a dump into a throwaway database, for validating an import. */
export async function loadDump(dumpPath: string): Promise<PGlite> {
  return load(dumpPath);
}

export async function cloneSource(
  projectId: string,
  dumpPath: string,
): Promise<PGliteInterface> {
  const source = await sourceDb(projectId, dumpPath);
  return source.clone();
}

export function dropSource(projectId: string) {
  const pending = sources.get(projectId);
  sources.delete(projectId);
  void pending?.then((pg) => pg.close()).catch(() => {});
}
