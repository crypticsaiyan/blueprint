import path from "node:path";

import { fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";

import { activeItems, compileMigration, shippableMigrationSql } from "../../shared/changes.js";
import type { RehearsalResult } from "../../shared/rehearsal-types.js";
import { getDb, schema } from "../db/index.js";
import { generateDrizzleSchemaFiles } from "./code/drizzle-codegen.js";
import { generatePrismaSchema } from "./code/prisma-codegen.js";
import { decodeText, encodeText, findSupabaseTypes, generateSupabaseTypes } from "./code/supabase-types.js";
import { migrationLayout, removeMigration, writeMigration } from "./migration-writer.js";
import { loadItems, nowIso, scopeOf, type ChangesetRow, type ProjectRow } from "./projects.js";
import { migratedDump } from "./run-rehearsal.js";
import {
  baselineBytes,
  baselineFile,
  ensureWorkspace,
  readWorkspaceBytes,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "./workspace.js";

export const RULES_FILE = ".blueprint/rules.json";
export const RULES_SCRIPT = "scripts/check-blueprint-rules.mjs";

function slug(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40) || "changes"
  );
}

/** The rule check that ships with the repo: plain Node, no dependencies. */
function rulesScript() {
  return `#!/usr/bin/env node
// Fails when a module imports code a Blueprint rule forbids.
// Rules live in ${RULES_FILE}; paths are prefixes from the repo root.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const rules = JSON.parse(readFileSync(join(root, "${RULES_FILE}"), "utf8")).rules;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\\.(ts|tsx|js|mjs)$/.test(name)) files.push(full);
  }
})(join(root, "src"));

const violations = [];
for (const file of files) {
  const from = relative(root, file);
  readFileSync(file, "utf8").split("\\n").forEach((line, index) => {
    const match = line.match(/^\\s*import\\s+(?!type\\b)[^'"]*['"](\\.{1,2}\\/[^'"]+)['"]/);
    if (!match) return;
    const to = relative(root, resolve(dirname(file), match[1]));
    for (const rule of rules) {
      if (from.startsWith(rule.fromModule) && to.startsWith(rule.toModule.replace(/\\.(ts|js)$/, ""))) {
        violations.push(\`\${from}:\${index + 1} imports \${to} (\${rule.reason || "forbidden by rule"})\`);
      }
    }
  });
}
if (violations.length) {
  console.error("Forbidden module dependencies:\\n" + violations.map((v) => "  " + v).join("\\n"));
  process.exit(1);
}
console.log(\`Dependency rules: \${rules.length} checked, no violations.\`);
`;
}

/** The dump's path in the repo, or null when the schema came from migrations. */
export function repoDumpPath(project: ProjectRow): string | null {
  const rel = path.relative(project.repoPath, project.dumpPath);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel.split(path.sep).join("/");
}

export interface SyncResult {
  dir: string;
  generated: string[];
  rehearsal: RehearsalResult | null;
  /** Why the migration and data were not written, when they were not. */
  pending: string | null;
}

/**
 * Brings the changeset's working copy in line with the plan: the Drizzle
 * schema, the migration file (with the chosen conflict fixes), the migrated
 * sample data, and the dependency-rule check. Agent edits are left alone.
 */
export async function syncWorkspace(project: ProjectRow, changeset: ChangesetRow): Promise<SyncResult> {
  const dir = await ensureWorkspace(project, changeset);
  const items = await loadItems(changeset.id);
  const active = activeItems(items);
  const generated: string[] = [];
  let rehearsal: RehearsalResult | null = null;
  let pending: string | null = null;

  const schemaFile = project.code?.schemaFile;
  const prisma = project.code?.adapter === "prisma";
  const schemaFiles = schemaFile
    ? project.code?.schemaFiles?.length
      ? project.code.schemaFiles
      : [schemaFile]
    : prisma
      ? (project.code?.schemaFiles ?? [])
      : [];
  let schemaNotes: string[] = [];
  if (schemaFiles.length) {
    const baselines = new Map<string, string>();
    for (const file of schemaFiles) {
      const text = await baselineFile(dir, file);
      if (text !== null) baselines.set(file, text);
    }
    let changed: Map<string, string>;
    try {
      if (prisma) {
        const result = generatePrismaSchema(baselines, items);
        changed = result.files;
        schemaNotes = result.notes;
      } else {
        changed = generateDrizzleSchemaFiles(baselines, items, schemaFile!, project.schema.tables.map((t) => t.name));
      }
    } catch (error) {
      fail(`Could not update the ${prisma ? "Prisma" : "Drizzle"} schema: ${(error as Error).message}`, { errorCode: "schema_codegen_failed" });
    }
    for (const [file, baseline] of baselines) {
      const next = changed.get(file) ?? baseline;
      if (next !== baseline || (await readWorkspaceFile(dir, file)) !== baseline) {
        await writeWorkspaceFile(dir, file, next);
      }
      if (next !== baseline) generated.push(file);
    }
  }

  // Supabase repos type the client with generated Database types; they
  // follow the schema so the typecheck sees what the change breaks.
  const typesFiles =
    project.code?.adapter === "supabase-js" ? (project.code.schemaFiles ?? (await findSupabaseTypes(dir))) : [];
  const typesNotes: string[] = [];
  for (const file of typesFiles) {
    const baseline = await baselineBytes(dir, file);
    if (!baseline) continue;
    const stored = decodeText(baseline);
    const result = generateSupabaseTypes(stored.text, items, project.schema);
    typesNotes.push(...result.notes);
    const next = result.text === stored.text ? baseline : encodeText(stored, result.text);
    const current = await readWorkspaceBytes(dir, file);
    if (!current?.equals(next)) await writeWorkspaceFile(dir, file, next);
    if (result.text !== stored.text) generated.push(file);
  }

  const layout = await migrationLayout(dir);
  let migrationFiles: string[] = [];
  let migrationNote: string | null = null;
  let dumpNote: string | null = null;
  const dumpRel = repoDumpPath(project);
  const restoreDump = async () => {
    const baseline = dumpRel ? await baselineFile(dir, dumpRel) : null;
    if (dumpRel && baseline !== null) await writeWorkspaceFile(dir, dumpRel, baseline);
  };
  if (active.length) {
    const { result, dump } = await migratedDump(project, changeset.id, items);
    rehearsal = result;
    if (result.status === "passed") {
      const header = `-- ${changeset.goal || "Schema changes"}\n-- Generated by Blueprint after a passing rehearsal${dumpRel ? " on the sample data" : ""}.\n\n`;
      const written = await writeMigration(
        dir,
        layout,
        changeset,
        slug(changeset.goal || "changes"),
        header,
        shippableMigrationSql(compileMigration(items, project.schema), result),
      );
      migrationFiles = written.files;
      // With schema.prisma updated, only what it could not express is left to say.
      migrationNote = prisma && schemaFiles.length ? schemaNotes.join(" ") || null : written.note;
      generated.push(...migrationFiles);
      if (dumpRel && dump) {
        await writeWorkspaceFile(dir, dumpRel, dump);
        generated.push(dumpRel);
      } else if (dumpRel) {
        // Hand-written schema files keep their own text; the migration carries the change.
        await restoreDump();
        dumpNote = `${dumpRel} is left as it is: it holds more than tables and rows, so Blueprint does not rewrite it. Update it from the migrated database if the repo keeps it in sync.`;
      }
    } else {
      pending = `The rehearsal is ${result.status}; the migration${dumpRel ? " and migrated data are" : " is"} written once it passes.`;
      await removeMigration(dir, layout, changeset.id);
      await restoreDump();
    }
  } else {
    await removeMigration(dir, layout, changeset.id);
    await restoreDump();
  }

  const rules = await getDb()
    .select({ fromModule: schema.rules.fromModule, toModule: schema.rules.toModule, reason: schema.rules.reason })
    .from(schema.rules)
    .where(eq(schema.rules.projectId, project.id))
    .limit(200);
  if (rules.length) {
    await writeWorkspaceFile(dir, RULES_FILE, `${JSON.stringify({ rules }, null, 2)}\n`);
    await writeWorkspaceFile(dir, RULES_SCRIPT, rulesScript());
    generated.push(RULES_FILE, RULES_SCRIPT);
    const pkgText = await readWorkspaceFile(dir, "package.json");
    if (pkgText) {
      const pkg = JSON.parse(pkgText);
      pkg.scripts = { ...pkg.scripts, "check:rules": `node ${RULES_SCRIPT}` };
      await writeWorkspaceFile(dir, "package.json", `${JSON.stringify(pkg, null, 2)}\n`);
      generated.push("package.json");
    }
  }

  const db = getDb();
  await db
    .delete(schema.codeEdits)
    .where(and(eq(schema.codeEdits.changesetId, changeset.id), eq(schema.codeEdits.origin, "generated")));
  if (generated.length) {
    await db.insert(schema.codeEdits).values(
      generated.map((file) => ({
        id: crypto.randomUUID(),
        changesetId: changeset.id,
        projectId: project.id,
        path: file,
        summary: typesFiles.includes(file)
          ? `Supabase types updated from the changeset${typesNotes.length ? `. ${typesNotes.join(" ")}` : ""}`
          : schemaFiles.includes(file) ? `${prisma ? "Prisma" : "Drizzle"} schema updated from the changeset${prisma && schemaNotes.length ? `. ${schemaNotes.join(" ")}` : ""}` : file === dumpRel ? "Sample data migrated" : file.endsWith("_journal.json")
              ? `Migration registered in the Drizzle journal${migrationNote ? `. ${migrationNote}` : ""}`
              : file.endsWith("_snapshot.json")
                ? "Drizzle snapshot of the new schema (from drizzle-kit)"
                : migrationFiles.includes(file)
                  ? `Migration with conflict fixes${layout.tool === "prisma" && migrationNote ? `. ${migrationNote}` : ""}${dumpNote ? `. ${dumpNote}` : ""}`
                  : "Dependency rule check",
        origin: "generated" as const,
        createdAt: nowIso(),
        ...scopeOf(project),
      })),
    );
  }
  return { dir, generated, rehearsal, pending };
}

/** Files Blueprint writes itself; agent edits go through the changeset instead. */
export async function generatedPaths(project: ProjectRow, changeset: ChangesetRow) {
  const rows = await getDb()
    .select({ path: schema.codeEdits.path })
    .from(schema.codeEdits)
    .where(and(eq(schema.codeEdits.changesetId, changeset.id), eq(schema.codeEdits.origin, "generated")))
    .limit(100);
  const out = new Set(rows.map((r) => r.path));
  if (project.code?.schemaFile) out.add(project.code.schemaFile);
  for (const file of project.code?.schemaFiles ?? []) out.add(file);
  const dumpRel = repoDumpPath(project);
  if (dumpRel) out.add(dumpRel);
  return out;
}
