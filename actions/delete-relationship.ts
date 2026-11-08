import { defineAction, fail } from "@agent-native/core/action";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { describeChange, identifier, projectSchema, q } from "../shared/changes.js";
import { getDb, schema } from "../server/db/index.js";
import {
  insertItems,
  loadItems,
  nextPosition,
  nowIso,
  openChangeset,
  requireProject,
  touchChangeset,
} from "../server/lib/projects.js";
import { sourceDb } from "../server/lib/sandbox.js";

export default defineAction({
  description:
    "Delete a relationship (foreign key) between two tables. With confirm false (default) it changes nothing and returns the dependent rows; with confirm true it adds a drop_foreign_key change, or rejects the proposal that introduced a ghost relationship.",
  schema: z.object({
    projectId: z.string().describe("Project id"),
    table: identifier.describe("Child table holding the foreign key"),
    column: identifier.describe("Foreign key column"),
    refTable: identifier.describe("Parent table"),
    confirm: z.boolean().default(false).describe("false to preview impact only; true to add the change"),
  }),
  outputSchema: z.object({
    id: z.string().nullable(),
    ghost: z.boolean(),
    dependentRows: z.number(),
    totalRows: z.number(),
    sample: z.array(z.record(z.string(), z.unknown())),
    constraint: z.string().nullable(),
    message: z.string(),
  }),
  run: async ({ projectId, table, column, refTable, confirm }) => {
    const project = await requireProject(projectId, confirm ? "editor" : "viewer");
    const changeset = await openChangeset(project);
    const items = await loadItems(changeset.id);
    const edge = projectSchema(project.schema, items).edges.find(
      (e) => e.table === table && e.column === column && e.refTable === refTable && !e.dropped,
    );
    if (!edge) fail(`No relationship ${table}.${column} → ${refTable}.`, { errorCode: "not_found", statusCode: 404 });

    if (edge.ghost) {
      if (confirm) {
        await getDb()
          .update(schema.changeItems)
          .set({ status: "rejected", updatedAt: nowIso() })
          .where(eq(schema.changeItems.id, edge.ghost.itemId));
        await touchChangeset(changeset.id);
      }
      return {
        id: confirm ? edge.ghost.itemId : null,
        ghost: true,
        dependentRows: 0,
        totalRows: 0,
        sample: [],
        constraint: null,
        message: confirm
          ? "Rejected the proposed relationship; no existing data depended on it."
          : "This relationship is only proposed; removing it rejects that proposal.",
      };
    }

    const pg = await sourceDb(project.id, project.dumpPath);
    const counts = await pg.query<{ linked: number; total: number }>(
      `SELECT count(${q(column)})::int AS linked, count(*)::int AS total FROM ${q(table)}`,
    );
    const sample = await pg.query<Record<string, unknown>>(
      `SELECT * FROM ${q(table)} WHERE ${q(column)} IS NOT NULL LIMIT 5`,
    );
    const linked = counts.rows[0]?.linked ?? 0;
    const total = counts.rows[0]?.total ?? 0;
    let id: string | null = null;
    if (confirm) {
      const [item] = await insertItems(
        project,
        changeset.id,
        [
          {
            payload: { kind: "drop_foreign_key", table, column, refTable, constraint: edge.constraint! },
            reason: "Deleted on the canvas.",
            origin: "drawing",
            status: "accepted",
          },
        ],
        await nextPosition(changeset.id, items),
      );
      id = item?.id ?? null;
    }
    const summary = describeChange({ kind: "drop_foreign_key", table, column, refTable, constraint: edge.constraint! });
    return {
      id,
      ghost: false,
      dependentRows: linked,
      totalRows: total,
      sample: sample.rows,
      constraint: edge.constraint,
      message: confirm
        ? `${summary}: added. ${linked} of ${total} ${table} rows lose their enforced link to ${refTable}.`
        : `${linked} of ${total} ${table} rows reference ${refTable} through ${column}. Postgres would stop enforcing that link.`,
    };
  },
});
