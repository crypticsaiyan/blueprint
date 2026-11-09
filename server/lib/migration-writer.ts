import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { noteExternalWrite } from "@agent-native/core/action";

import { splitStatements } from "./sql-statements.js";
import { drizzleConfigs, findMigrations } from "./schema-source.js";
import { readWorkspaceFile, resolveInside, writeWorkspaceFile } from "./workspace.js";

// Ships the migration the way the repo's own tool expects it, so the next
// `drizzle-kit migrate`, `supabase db push` or `prisma migrate deploy` runs it.

export interface MigrationLayout {
  tool: "drizzle" | "supabase" | "prisma" | "sql";
  /** Folder relative to the repo root. */
  dir: string;
  /** Drizzle only applies migrations listed in meta/_journal.json. */
  journal: boolean;
  /** The Drizzle config that names this folder, relative to the repo root. */
  config?: string | undefined;
}

export interface WrittenMigration {
  files: string[];
  /** What a reviewer should know, e.g. that the Drizzle snapshot is missing. */
  note: string | null;
}

interface Journal {
  version?: string;
  dialect?: string;
  entries: { idx: number; version?: string; when: number; tag: string; breakpoints?: boolean }[];
}

const posix = (p: string) => p.split(path.sep).join("/");

export async function migrationLayout(dir: string): Promise<MigrationLayout> {
  const configs = await drizzleConfigs(dir);
  const configFor = (abs: string) => {
    const match = configs.find((c) => c.dir === abs);
    return match ? posix(path.relative(dir, match.config)) : undefined;
  };
  const found = await findMigrations(dir);
  if (found?.kind === "migrations") {
    const rel = posix(path.relative(dir, found.dir));
    const journal = found.tool === "drizzle" && (await readWorkspaceFile(dir, `${rel}/meta/_journal.json`)) !== null;
    return { tool: found.tool, dir: rel, journal, config: found.tool === "drizzle" ? configFor(found.dir) : undefined };
  }
  const [drizzle] = configs;
  if (drizzle) return { tool: "drizzle", dir: posix(path.relative(dir, drizzle.dir)), journal: false, config: configFor(drizzle.dir) };
  return { tool: "sql", dir: "migrations", journal: false };
}

async function exists(file: string) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** The repo's own drizzle-kit, once its dependencies are installed. */
async function drizzleKit(dir: string, configDir: string) {
  for (const base of [configDir, dir]) {
    const bin = path.join(base, "node_modules/.bin/drizzle-kit");
    if (await exists(bin)) return bin;
  }
  return null;
}

/**
 * `drizzle-kit generate` writes the snapshot and journal entry Drizzle needs
 * to see this migration as applied. It does not connect to a database, but
 * configs often read a URL from the environment, so a placeholder is set.
 */
function runDrizzleKit(bin: string, cwd: string, config: string, name: string): Promise<boolean> {
  const url = "postgres://blueprint:blueprint@127.0.0.1:5432/blueprint";
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ["generate", `--name=${name}`, `--config=${config}`],
      { cwd, timeout: 120_000, env: { ...process.env, DATABASE_URL: url, POSTGRES_URL: url, DB_URL: url, CI: "1" } },
      (error) => resolve(!error),
    );
    // A rename prompt would wait forever; closed input makes it fail instead.
    child.stdin?.end();
  });
}

/** Removes journal entries, SQL files and snapshots an earlier sync wrote. */
async function dropDrizzleEntries(dir: string, layout: MigrationLayout, marker: string) {
  const journalPath = `${layout.dir}/meta/_journal.json`;
  const text = await readWorkspaceFile(dir, journalPath);
  if (!text) return;
  const journal = JSON.parse(text) as Journal;
  const ours = journal.entries.filter((e) => e.tag.includes(marker));
  if (!ours.length) return;
  for (const entry of ours) {
    const prefix = entry.tag.split("_")[0];
    await rm(resolveInside(dir, `${layout.dir}/meta/${prefix}_snapshot.json`), { force: true });
    await rm(resolveInside(dir, `${layout.dir}/${entry.tag}.sql`), { force: true });
  }
  journal.entries = journal.entries.filter((e) => !e.tag.includes(marker));
  await writeWorkspaceFile(dir, journalPath, `${JSON.stringify(journal, null, 2)}${text.endsWith("\n") ? "\n" : ""}`);
}

/** YYYYMMDDHHMMSS, the prefix Supabase, Prisma and Drizzle's timestamp mode use. */
function stamp(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** A timestamp after every existing one, stable across re-syncs of the same changeset. */
function nextStamp(createdAt: string, names: string[]) {
  const ts = stamp(createdAt);
  const latest = names.map((n) => n.match(/^(\d{14})_/)?.[1]).filter((n): n is string => Boolean(n)).sort().pop();
  return latest && latest >= ts ? String(Number(latest) + 1) : ts;
}

/**
 * Drizzle splits on this marker when the journal entry sets `breakpoints`.
 * Its migrator wraps migrations in a transaction, so BEGIN/COMMIT go.
 */
function withBreakpoints(sql: string) {
  const { statements } = splitStatements(sql);
  return statements
    .filter((s) => !/^(BEGIN|COMMIT)\s*;$/i.test(s.body.trim()))
    .map((s) => `${s.lead.replace(/^\n+/, "")}${s.body}`)
    .join("\n--> statement-breakpoint\n");
}

/**
 * Writes the migration for a changeset, replacing what an earlier sync wrote.
 * Returns the repo paths it wrote.
 */
export async function writeMigration(
  dir: string,
  layout: MigrationLayout,
  changeset: { id: string; createdAt: string },
  slug: string,
  header: string,
  sql: string,
): Promise<WrittenMigration> {
  const marker = `blueprint_${changeset.id.slice(0, 8)}`;
  const abs = resolveInside(dir, layout.dir);
  noteExternalWrite("local-disk");
  let names: string[] = [];
  try {
    names = await readdir(abs);
  } catch {
    // No migrations folder yet; writing the file creates it.
  }
  for (const name of names.filter((n) => n.includes(marker))) await rm(path.join(abs, name), { recursive: true, force: true });
  names = names.filter((n) => !n.includes(marker));

  if (layout.tool === "drizzle" && layout.journal) {
    await dropDrizzleEntries(dir, layout, marker);
    const journalPath = `${layout.dir}/meta/_journal.json`;
    const body = `${header}${withBreakpoints(sql)}\n`;
    const configAbs = layout.config ? resolveInside(dir, layout.config) : null;
    const bin = configAbs ? await drizzleKit(dir, path.dirname(configAbs)) : null;
    if (bin && configAbs && (await runDrizzleKit(bin, path.dirname(configAbs), path.basename(configAbs), `${marker}_${slug}`))) {
      const journal = JSON.parse((await readWorkspaceFile(dir, journalPath))!) as Journal;
      const entry = journal.entries.find((e) => e.tag.includes(marker));
      if (entry) {
        // drizzle-kit's own SQL would add NOT NULL columns without a backfill;
        // the rehearsed migration replaces it, its snapshot and entry stay.
        const file = `${layout.dir}/${entry.tag}.sql`;
        await writeWorkspaceFile(dir, file, body);
        const snapshot = `${layout.dir}/meta/${entry.tag.split("_")[0]}_snapshot.json`;
        return { files: [file, snapshot, journalPath], note: null };
      }
    }
    // No drizzle-kit (dependencies not installed yet): register the file by hand.
    const text = (await readWorkspaceFile(dir, journalPath))!;
    const journal = JSON.parse(text) as Journal;
    const last = journal.entries.reduce<Journal["entries"][number] | undefined>((a, e) => (!a || e.idx > a.idx ? e : a), undefined);
    const idx = last ? last.idx + 1 : 0;
    const prefix = last && /^\d{14}_/.test(last.tag) ? nextStamp(changeset.createdAt, journal.entries.map((e) => e.tag)) : String(idx).padStart(4, "0");
    const tag = `${prefix}_${marker}_${slug}`;
    const when = Math.max(Date.parse(changeset.createdAt), (last?.when ?? 0) + 1);
    journal.entries.push({ idx, version: last?.version ?? journal.version ?? "7", when, tag, breakpoints: true });
    const file = `${layout.dir}/${tag}.sql`;
    await writeWorkspaceFile(dir, file, body);
    await writeWorkspaceFile(dir, journalPath, `${JSON.stringify(journal, null, 2)}${text.endsWith("\n") ? "\n" : ""}`);
    return {
      files: [file, journalPath],
      note: "No Drizzle snapshot yet: run the tests (which installs dependencies) so drizzle-kit can write it.",
    };
  }
  if (layout.tool === "supabase") {
    const file = `${layout.dir}/${nextStamp(changeset.createdAt, names)}_${marker}_${slug}.sql`;
    await writeWorkspaceFile(dir, file, header + sql);
    return { files: [file], note: null };
  }
  if (layout.tool === "prisma") {
    const file = `${layout.dir}/${nextStamp(changeset.createdAt, names)}_${marker}_${slug}/migration.sql`;
    await writeWorkspaceFile(dir, file, header + sql);
    return { files: [file], note: "Prisma's schema.prisma is not updated; run `prisma db pull` or edit it to match." };
  }
  // Plain folders: follow the numbering the existing files use.
  const numbered = names.map((n) => n.match(/^(\d+)[_-]/)?.[1]).filter((n): n is string => Boolean(n));
  let prefix = "";
  if (numbered.some((n) => n.length === 14)) prefix = `${nextStamp(changeset.createdAt, names)}_`;
  else if (numbered.length) {
    const width = numbered[numbered.length - 1]!.length;
    prefix = `${String(Math.max(...numbered.map(Number)) + 1).padStart(width, "0")}_`;
  }
  const file = `${layout.dir}/${prefix}${marker}_${slug}.sql`;
  await writeWorkspaceFile(dir, file, header + sql);
  return { files: [file], note: null };
}

/** Restores the journal when the changeset no longer ships a migration. */
export async function removeMigration(dir: string, layout: MigrationLayout, changesetId: string) {
  const marker = `blueprint_${changesetId.slice(0, 8)}`;
  const abs = resolveInside(dir, layout.dir);
  noteExternalWrite("local-disk");
  try {
    for (const name of await readdir(abs)) {
      if (name.includes(marker)) await rm(path.join(abs, name), { recursive: true, force: true });
    }
  } catch {
    return;
  }
  if (layout.tool === "drizzle" && layout.journal) await dropDrizzleEntries(dir, layout, marker);
}
