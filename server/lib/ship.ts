import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { fail, noteExternalWrite } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";

import { activeItems, compileMigration, shippableMigrationSql } from "../../shared/changes.js";
import type { RehearsalResult } from "../../shared/rehearsal-types.js";
import { getDb, schema } from "../db/index.js";
import { generateDrizzleSchema } from "./code/drizzle-codegen.js";
import { loadItems, nowIso, scopeOf, type ChangesetRow, type ProjectRow } from "./projects.js";
import { migratedDump } from "./run-rehearsal.js";
import {
  baselineFile,
  ensureWorkspace,
  readWorkspaceFile,
  resolveInside,
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

async function migrationsDir(dir: string): Promise<string> {
  const config = (await readWorkspaceFile(dir, "drizzle.config.ts")) ?? (await readWorkspaceFile(dir, "drizzle.config.js"));
  const out = config?.match(/out:\s*["'`]\.?\/?([^"'`]+)["'`]/)?.[1];
  return out ? out.replace(/\/$/, "") : "migrations";
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
  if (schemaFile) {
    const baseline = await baselineFile(dir, schemaFile);
    if (baseline !== null) {
      let next: string;
      try {
        next = generateDrizzleSchema(baseline, items);
      } catch (error) {
        fail(`Could not update ${schemaFile}: ${(error as Error).message}`, { errorCode: "schema_codegen_failed" });
      }
      if (next !== baseline || (await readWorkspaceFile(dir, schemaFile)) !== baseline) {
        await writeWorkspaceFile(dir, schemaFile, next);
      }
      if (next !== baseline) generated.push(schemaFile);
    }
  }

  const outDir = await migrationsDir(dir);
  const prefix = `blueprint_${changeset.id.slice(0, 8)}_`;
  noteExternalWrite("local-disk");
  try {
    for (const name of await readdir(resolveInside(dir, outDir))) {
      if (name.startsWith(prefix)) await rm(path.join(resolveInside(dir, outDir), name));
    }
  } catch {
    // No migrations directory yet.
  }
  const dumpRel = path.relative(project.repoPath, project.dumpPath).split(path.sep).join("/");
  if (active.length) {
    const { result, dump } = await migratedDump(project, changeset.id, items);
    rehearsal = result;
    if (dump) {
      const file = `${outDir}/${prefix}${slug(changeset.goal || "changes")}.sql`;
      const header = `-- ${changeset.goal || "Schema changes"}\n-- Generated by Blueprint after a passing rehearsal on the sample data.\n\n`;
      await writeWorkspaceFile(dir, file, header + shippableMigrationSql(compileMigration(items, project.schema), result));
      await writeWorkspaceFile(dir, dumpRel, dump);
      generated.push(file, dumpRel);
    } else {
      pending = `The rehearsal is ${result.status}; the migration and migrated data are written once it passes.`;
      const baseline = await baselineFile(dir, dumpRel);
      if (baseline !== null) await writeWorkspaceFile(dir, dumpRel, baseline);
    }
  } else {
    const baseline = await baselineFile(dir, dumpRel);
    if (baseline !== null) await writeWorkspaceFile(dir, dumpRel, baseline);
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
        summary: file === schemaFile ? "Drizzle schema updated from the changeset" : file === dumpRel ? "Sample data migrated" : file.startsWith(outDir) ? "Migration with conflict fixes" : "Dependency rule check",
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
  out.add(path.relative(project.repoPath, project.dumpPath).split(path.sep).join("/"));
  return out;
}
