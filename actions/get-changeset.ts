import { defineAction } from "@agent-native/core/action";
import { desc, eq, ne } from "drizzle-orm";
import { and } from "drizzle-orm";
import { z } from "zod";

import { compileMigration, describeChange, migrationSql, shippableMigrationSql } from "../shared/changes.js";
import type { RehearsalResult } from "../shared/rehearsal-types.js";
import { getDb, schema } from "../server/db/index.js";
import { changeItemOutput, jsonObject } from "../server/lib/output-schemas.js";
import { findOpenChangeset, loadItems, requireProject } from "../server/lib/projects.js";

export default defineAction({
  description:
    "Read the open changeset for a project: items with status and locks, the compiled migration SQL in run order, the latest rehearsal result (steps, before/after rows), and conflicts with their fix choices.",
  schema: z.object({ projectId: z.string().describe("Project id") }),
  http: { method: "GET" },
  readOnly: true,
  outputSchema: z.object({
    changeset: z.object({ id: z.string(), goal: z.string(), updatedAt: z.string() }).nullable(),
    items: z.array(changeItemOutput),
    steps: z.array(z.object({ itemId: z.string(), phase: z.number(), label: z.string(), sql: z.string() })),
    sql: z.string(),
    rehearsal: z
      .object({ id: z.string(), status: z.string(), createdAt: z.string(), stale: z.boolean(), result: jsonObject })
      .nullable(),
    conflicts: z.array(
      z.object({
        id: z.string(),
        key: z.string(),
        itemId: z.string(),
        kind: z.string(),
        table: z.string(),
        rowCount: z.number(),
        status: z.string(),
        fix: z.string().nullable(),
        fixValue: z.string().nullable(),
        message: z.string(),
        fixes: z.array(jsonObject),
      }),
    ),
  }),
  run: async ({ projectId }) => {
    const project = await requireProject(projectId);
    const changeset = await findOpenChangeset(projectId);
    if (!changeset) {
      return { changeset: null, items: [], steps: [], sql: migrationSql([]), rehearsal: null, conflicts: [] };
    }
    const items = await loadItems(changeset.id);
    const steps = compileMigration(items, project.schema);
    const db = getDb();
    const [rehearsal] = await db
      .select()
      .from(schema.rehearsals)
      .where(eq(schema.rehearsals.changesetId, changeset.id))
      .orderBy(desc(schema.rehearsals.createdAt))
      .limit(1);
    const conflictRows = await db
      .select()
      .from(schema.conflicts)
      .where(and(eq(schema.conflicts.changesetId, changeset.id), ne(schema.conflicts.status, "gone")))
      .limit(200);
    return {
      changeset: { id: changeset.id, goal: changeset.goal, updatedAt: changeset.updatedAt },
      items: items.map((item) => ({
        ...item,
        payload: item.payload as Record<string, unknown>,
        summary: describeChange(item.payload),
      })),
      steps: steps.map(({ itemId, phase, label, sql }) => ({ itemId, phase, label, sql })),
      sql:
        rehearsal && rehearsal.createdAt >= changeset.updatedAt
          ? shippableMigrationSql(steps, rehearsal.result as RehearsalResult)
          : migrationSql(steps),
      rehearsal: rehearsal
        ? {
            id: rehearsal.id,
            status: rehearsal.status,
            createdAt: rehearsal.createdAt,
            stale: rehearsal.createdAt < changeset.updatedAt,
            result: rehearsal.result as unknown as Record<string, unknown>,
          }
        : null,
      conflicts: conflictRows.map((row) => ({
        id: row.id,
        key: row.key,
        itemId: row.itemId,
        kind: row.kind,
        table: row.tableName,
        rowCount: row.rowCount,
        status: row.status,
        fix: row.fix,
        fixValue: row.fixValue,
        message: row.detail.message,
        fixes: row.detail.fixes as unknown as Record<string, unknown>[],
      })),
    };
  },
});
