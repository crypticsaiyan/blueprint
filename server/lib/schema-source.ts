import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { fail, noteExternalWrite } from "@agent-native/core/action";

import { dataPath } from "./data-dir.js";
import { splitStatements } from "./sql-statements.js";

// Where a repo's database comes from. Best is a real dump with rows; most
// repos only keep migrations, so those are replayed in order to rebuild the
// schema (with no rows unless a seed file sits next to them).

export type SchemaSource =
  | { kind: "dump"; file: string }
  | {
      kind: "migrations";
      tool: "drizzle" | "supabase" | "prisma" | "sql";
      dir: string;
      files: string[];
      seed: string | null;
    };

const DUMP_CANDIDATES = [
  "db/dump.sql",
  "dump.sql",
  "db/seed.sql",
  "seed.sql",
  "database/dump.sql",
  "sql/dump.sql",
  "db/schema.sql",
  "schema.sql",
];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".output", "coverage"]);
const SOURCES_DIR = dataPath("sources");

async function isFile(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isDir(dir: string) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function looksLikeDump(file: string) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 50 * 1024 * 1024) return false;
    const head = (await readFile(file, "utf8")).slice(0, 200_000);
    return /create\s+table/i.test(head);
  } catch {
    return false;
  }
}

async function walk(dir: string, depth: number, match: (name: string) => boolean, out: string[]) {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, depth - 1, match, out);
    else if (match(entry.name)) out.push(full);
  }
}

const sqlFilesIn = async (dir: string) =>
  (await readdir(dir))
    .filter((name) => name.endsWith(".sql") && !/\.down\.sql$/i.test(name))
    .sort()
    .map((name) => path.join(dir, name));

/** Postgres Drizzle configs in the repo and the migrations folder each names (`out`). */
export async function drizzleConfigs(repoPath: string): Promise<{ config: string; dir: string }[]> {
  const configs: string[] = [];
  await walk(repoPath, 3, (name) => /^drizzle\.config\.(ts|js|mjs|cjs|mts|json)$/.test(name), configs);
  const out: { config: string; dir: string }[] = [];
  for (const config of configs.sort((a, b) => a.length - b.length)) {
    const text = await readFile(config, "utf8");
    const dialect = text.match(/dialect:\s*["'`](\w+)["'`]/)?.[1] ?? text.match(/driver:\s*["'`](\w+)["'`]/)?.[1];
    if (dialect && !/^(postgresql|pg|postgres|pglite)$/.test(dialect)) continue;
    const folder = text.match(/out:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "drizzle";
    out.push({ config, dir: path.resolve(path.dirname(config), folder) });
  }
  return out;
}

export async function drizzleOutDirs(repoPath: string): Promise<string[]> {
  return (await drizzleConfigs(repoPath)).map((c) => c.dir);
}

async function drizzleMigrations(repoPath: string): Promise<SchemaSource | null> {
  for (const dir of await drizzleOutDirs(repoPath)) {
    if (!(await isDir(dir))) continue;
    let files: string[];
    try {
      // The journal is the order drizzle-kit applies migrations in.
      const journal = JSON.parse(await readFile(path.join(dir, "meta/_journal.json"), "utf8")) as {
        entries: { idx: number; tag: string }[];
      };
      files = journal.entries.sort((a, b) => a.idx - b.idx).map((e) => path.join(dir, `${e.tag}.sql`));
    } catch {
      files = await sqlFilesIn(dir);
    }
    files = (await Promise.all(files.map(async (f) => ((await isFile(f)) ? f : null)))).filter((f): f is string => f !== null);
    if (files.length) return { kind: "migrations", tool: "drizzle", dir, files, seed: null };
  }
  return null;
}

/** The repo's migrations folder and tool, when it keeps SQL migrations. */
export async function findMigrations(repoPath: string) {
  return (await drizzleMigrations(repoPath)) ?? (await otherMigrations(repoPath));
}

/**
 * Prisma migration folders, found by the migration_lock.toml Prisma writes
 * (monorepos keep them under packages/ or apps/), Postgres ones only.
 */
async function prismaDirs(repoPath: string) {
  const locks: string[] = [];
  await walk(repoPath, 4, (name) => name === "migration_lock.toml", locks);
  const dirs: string[] = [];
  for (const lock of locks.sort((a, b) => a.length - b.length)) {
    const provider = (await readFile(lock, "utf8")).match(/provider\s*=\s*"(\w+)"/)?.[1];
    if (provider === "postgresql" || provider === "postgres") dirs.push(path.dirname(lock));
  }
  const fallback = path.join(repoPath, "prisma/migrations");
  if (!dirs.length && (await isDir(fallback))) dirs.push(fallback);
  return dirs;
}

async function otherMigrations(repoPath: string): Promise<SchemaSource | null> {
  const supabase = path.join(repoPath, "supabase/migrations");
  if (await isDir(supabase)) {
    const files = await sqlFilesIn(supabase);
    const seed = path.join(repoPath, "supabase/seed.sql");
    if (files.length) return { kind: "migrations", tool: "supabase", dir: supabase, files, seed: (await isFile(seed)) ? seed : null };
  }
  for (const prisma of await prismaDirs(repoPath)) {
    const dirs = (await readdir(prisma, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const files: string[] = [];
    for (const name of dirs) {
      // Some folders hold data migrations in TypeScript, with no SQL.
      const file = path.join(prisma, name, "migration.sql");
      if (await isFile(file)) files.push(file);
    }
    if (files.length) return { kind: "migrations", tool: "prisma", dir: prisma, files, seed: null };
  }
  for (const rel of ["migrations", "db/migrations", "database/migrations", "sql/migrations", "drizzle"]) {
    const dir = path.join(repoPath, rel);
    if (!(await isDir(dir))) continue;
    const files = await sqlFilesIn(dir);
    if (files.length) return { kind: "migrations", tool: "sql", dir, files, seed: null };
  }
  return null;
}

/**
 * Finds the repo's database: an explicit path (a dump file or a migrations
 * folder), a known dump name, the migrations folder, then any .sql with tables.
 */
export async function findSchemaSource(repoPath: string, explicit?: string): Promise<SchemaSource> {
  if (explicit) {
    const full = path.resolve(repoPath, explicit);
    if (!full.startsWith(repoPath + path.sep)) fail(`${explicit} is outside the repo.`, { errorCode: "dump_not_found" });
    if (await isDir(full)) {
      const files = await sqlFilesIn(full);
      if (files.length) return { kind: "migrations", tool: "sql", dir: full, files, seed: null };
    } else if (await looksLikeDump(full)) {
      return { kind: "dump", file: full };
    }
    fail(`No SQL dump or migrations with CREATE TABLE statements at ${explicit}.`, { errorCode: "dump_not_found" });
  }
  for (const candidate of DUMP_CANDIDATES) {
    const full = path.join(repoPath, candidate);
    if (await looksLikeDump(full)) return { kind: "dump", file: full };
  }
  const migrations = await findMigrations(repoPath);
  if (migrations) return migrations;
  const found: string[] = [];
  await walk(repoPath, 3, (name) => name.endsWith(".sql"), found);
  for (const file of found.sort()) {
    if (await looksLikeDump(file)) return { kind: "dump", file };
  }
  fail(
    "No database found. Add a plain SQL dump (pg_dump --inserts) such as db/dump.sql, keep SQL migrations in the repo, or pass dumpPath.",
    { errorCode: "dump_not_found" },
  );
}

// Supabase migrations lean on schemas the platform provides. These stand-ins
// are just enough for policies, triggers and foreign keys to load.
/** Line between migration files; the sandbox runs each part on its own. */
export const MIGRATION_BOUNDARY = "-- blueprint:migration";

export const SUPABASE_PRELUDE = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
-- Supabase puts extensions on the search path; ALTER DATABASE keeps it in clones.
DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = "$user", public, extensions', current_database());
END $$;
SET search_path = "$user", public, extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated'::text $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner uuid,
  public boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;
CREATE OR REPLACE FUNCTION storage.extension(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT reverse(split_part(reverse(name), '.', 1)) $$;
`;

/**
 * SQL written for Supabase: it points at auth, storage or the platform roles
 * without creating them (a full platform dump creates its own auth schema).
 */
export function needsSupabase(sql: string) {
  if (/create\s+schema\s+(if\s+not\s+exists\s+)?"?auth"?/i.test(sql)) return false;
  return /\b(auth|storage)\.(users|uid|role|jwt|buckets|objects|foldername|filename|extension)\b|\bto\s+(authenticated|anon|service_role)\b/i.test(sql);
}

/**
 * The SQL file Blueprint loads: the dump itself, or the migrations joined in
 * order (kept under data/sources, outside the repo, since it is not shipped).
 */
export async function materializeSource(projectId: string, repoPath: string, source: SchemaSource): Promise<string> {
  if (source.kind === "dump") return source.file;
  const parts = [`-- Schema rebuilt by Blueprint from ${source.files.length} ${source.tool} migrations.\n`];
  for (const file of [...source.files, ...(source.seed ? [source.seed] : [])]) {
    const rel = path.relative(repoPath, file).split(path.sep).join("/");
    // Drizzle separates statements with a marker comment; plain ; is enough here.
    let sql = (await readFile(file, "utf8")).replace(/-->\s*statement-breakpoint/g, "").trimEnd();
    // Tools run a file's last statement without a semicolon; joined files need one.
    if (/\S/.test(splitStatements(sql).tail.replace(/--[^\n]*/g, ""))) sql += ";";
    // Each migration commits on its own, as the tools run them (an enum value
    // added in one file can only be used once that file has committed).
    parts.push(`\n${MIGRATION_BOUNDARY}\n-- ${rel}\n${sql}\n`);
  }
  await mkdir(SOURCES_DIR, { recursive: true });
  noteExternalWrite("local-disk");
  const out = path.join(SOURCES_DIR, `${projectId}.sql`);
  await writeFile(out, parts.join(""));
  return out;
}

/** True for SQL an import rebuilt from migrations, as opposed to a dump in the repo. */
export const isMaterializedSource = (dumpPath: string) => path.dirname(path.resolve(dumpPath)) === SOURCES_DIR;

/** Removes the SQL an import rebuilt from migrations; repo dumps are left alone. */
export async function removeMaterializedSource(dumpPath: string) {
  if (!isMaterializedSource(dumpPath)) return;
  noteExternalWrite("local-disk");
  await rm(dumpPath, { force: true });
}

export const describeSource = (repoPath: string, source: SchemaSource) =>
  source.kind === "dump"
    ? path.relative(repoPath, source.file)
    : `${source.files.length} ${source.tool} migrations in ${path.relative(repoPath, source.dir) || "."}`;
