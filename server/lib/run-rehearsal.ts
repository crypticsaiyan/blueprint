import { and, eq, isNotNull } from "drizzle-orm";

import { compileMigration, migrationSql, type ChangeItem } from "../../shared/changes.js";
import type { FixId, RehearsalResult, Resolution } from "../../shared/rehearsal-types.js";
import { getDb, schema } from "../db/index.js";
import { nowIso, scopeOf, type ProjectRow } from "./projects.js";
import { rehearse } from "./rehearse.js";
import { cloneSource } from "./sandbox.js";

export async function savedResolutions(changesetId: string): Promise<Resolution[]> {
  const rows = await getDb()
    .select({ key: schema.conflicts.key, fix: schema.conflicts.fix, value: schema.conflicts.fixValue })
    .from(schema.conflicts)
    .where(and(eq(schema.conflicts.changesetId, changesetId), isNotNull(schema.conflicts.fix)))
    .limit(500);
  return rows.map((row) => ({ key: row.key, fix: row.fix as FixId, value: row.value ?? undefined }));
}

/** Runs the plan on a throwaway copy of the sample data. Nothing is saved. */
export async function dryRun(
  project: ProjectRow,
  items: ChangeItem[],
  resolutions: Resolution[],
  measure?: { table: string; column: string },
): Promise<RehearsalResult> {
  const pg = await cloneSource(project.id, project.dumpPath);
  try {
    return await rehearse({ pg, items, snapshot: project.schema, resolutions, ...(measure ? { measure } : {}) });
  } finally {
    await pg.close();
  }
}

/** Runs a rehearsal and records it, with one conflict row per conflict key. */
export async function recordRehearsal(
  project: ProjectRow,
  changesetId: string,
  items: ChangeItem[],
) {
  const resolutions = await savedResolutions(changesetId);
  const result = await dryRun(project, items, resolutions);
  const id = crypto.randomUUID();
  const db = getDb();
  const scope = scopeOf(project);
  await db.insert(schema.rehearsals).values({
    id,
    changesetId,
    projectId: project.id,
    status: result.status,
    sql: migrationSql(compileMigration(items, project.schema)),
    result,
    createdAt: nowIso(),
    ...scope,
  });

  const existing = await db
    .select({ id: schema.conflicts.id, key: schema.conflicts.key })
    .from(schema.conflicts)
    .where(eq(schema.conflicts.changesetId, changesetId))
    .limit(500);
  const seen = new Set<string>();
  for (const report of result.conflicts) {
    seen.add(report.key);
    const values = {
      rehearsalId: id,
      itemId: report.itemId,
      kind: report.kind,
      tableName: report.table,
      rowCount: report.rowCount,
      detail: report,
      status: report.resolution ? ("resolved" as const) : ("open" as const),
      updatedAt: nowIso(),
    };
    const match = existing.find((row) => row.key === report.key);
    if (match) {
      await db.update(schema.conflicts).set(values).where(eq(schema.conflicts.id, match.id));
    } else {
      await db.insert(schema.conflicts).values({
        id: crypto.randomUUID(),
        changesetId,
        projectId: project.id,
        key: report.key,
        createdAt: nowIso(),
        ...values,
        ...scope,
      });
    }
  }
  for (const row of existing) {
    if (!seen.has(row.key)) {
      await db
        .update(schema.conflicts)
        .set({ status: "gone", updatedAt: nowIso() })
        .where(eq(schema.conflicts.id, row.id));
    }
  }
  return { id, result };
}

export function summarize(result: RehearsalResult) {
  const byStatus: Record<string, number> = {};
  for (const step of result.steps) byStatus[step.status] = (byStatus[step.status] ?? 0) + 1;
  return {
    status: result.status,
    steps: byStatus,
    durationMs: result.durationMs,
    tables: result.tables.map((t) => ({
      table: t.table,
      isNew: t.isNew,
      newColumns: t.newColumns,
      ...t.counts,
    })),
    errors: result.steps
      .filter((s) => s.status === "error")
      .map((s) => ({ step: s.label, error: s.error ?? "" })),
  };
}
