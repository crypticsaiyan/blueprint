import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import {
  backfillSqlForPath,
  compileMigration,
  describeChange,
  findBackfillPath,
  identifier,
  migrationSql,
  primaryKeyColumn,
  projectSchema,
  type ChangePayload,
} from "../shared/changes.js";
import { changeItemOutput } from "../server/lib/output-schemas.js";
import {
  insertItems,
  loadItems,
  nextPosition,
  openChangeset,
  requireProject,
} from "../server/lib/projects.js";
import { dryRun, savedResolutions } from "../server/lib/run-rehearsal.js";

function singular(name: string) {
  if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
  if (name.endsWith("ses")) return name.slice(0, -2);
  if (name.endsWith("s")) return name.slice(0, -1);
  return name;
}

export default defineAction({
  description:
    "Draw a relationship: every row of fromTable belongs to a row of toTable. Proposes the foreign-key column, a backfill that follows existing foreign keys when a path exists, and the constraint, then dry-runs the plan on the sample data and reports how many rows the backfill fills.",
  schema: z.object({
    projectId: z.string().describe("Project id"),
    fromTable: identifier.describe("Child table that gets the foreign key, e.g. invoices"),
    toTable: identifier.describe("Parent table it points at, e.g. orgs"),
    column: identifier.optional().describe("Foreign key column; defaults to <singular toTable>_id"),
  }),
  outputSchema: z.object({
    id: z.string(),
    items: z.array(changeItemOutput),
    sql: z.string(),
    backfill: z.object({
      path: z.string().nullable(),
      total: z.number(),
      filled: z.number(),
      empty: z.number(),
    }),
    conflicts: z.number(),
    message: z.string(),
  }),
  run: async ({ projectId, fromTable, toTable, column }) => {
    const project = await requireProject(projectId, "editor");
    const changeset = await openChangeset(project);
    const existing = await loadItems(changeset.id);
    const projected = projectSchema(project.schema, existing);
    const from = projected.tables.find((t) => t.name === fromTable);
    const to = projected.tables.find((t) => t.name === toTable);
    if (!from || !to) fail("Both tables must exist on the map.", { errorCode: "table_not_found", statusCode: 404 });
    if (fromTable === toTable) fail("Draw between two different tables.", { errorCode: "same_table" });
    const refColumn = primaryKeyColumn(to);
    const refType = to.columns.find((c) => c.name === refColumn)?.type;
    if (!refColumn || !refType) fail(`${toTable} has no single-column primary key.`, { errorCode: "no_primary_key" });

    const fkColumn = column ?? `${singular(toTable)}_id`;
    const already = projected.edges.find(
      (e) => e.table === fromTable && e.column === fkColumn && e.refTable === toTable && !e.dropped,
    );
    if (already) fail(`${fromTable}.${fkColumn} already points at ${toTable}.`, { errorCode: "already_related", statusCode: 409 });

    const entries: { payload: ChangePayload; reason: string }[] = [];
    const hasColumn = from.columns.some((c) => c.name === fkColumn);
    let pathText: string | null = null;
    if (!hasColumn) {
      const path = findBackfillPath(projected, fromTable, toTable);
      entries.push({
        payload: {
          kind: "add_column",
          table: fromTable,
          column: { name: fkColumn, type: refType, nullable: !path },
        },
        reason: `Every ${singular(fromTable)} belongs to one ${singular(toTable)}.`,
      });
      if (path) {
        pathText = [fromTable, ...path.hops.map((h) => `${h.column} → ${h.refTable}`), path.sourceColumn].join(" · ");
        entries.push({
          payload: {
            kind: "backfill",
            table: fromTable,
            column: fkColumn,
            sql: backfillSqlForPath(fromTable, fkColumn, path),
          },
          reason: `Fill existing rows by following ${path.hops.map((h) => `${h.table}.${h.column}`).join(", ")} to ${path.hops[path.hops.length - 1]!.refTable}.${path.sourceColumn}.`,
        });
      }
    }
    entries.push({
      payload: {
        kind: "add_foreign_key",
        table: fromTable,
        column: fkColumn,
        refTable: toTable,
        refColumn,
        onDelete: "no action",
      },
      reason: `Postgres enforces that ${fromTable}.${fkColumn} points at a real ${singular(toTable)}.`,
    });

    const added = await insertItems(
      project,
      changeset.id,
      entries.map((e) => ({ ...e, origin: "drawing" as const, status: "accepted" as const })),
      await nextPosition(changeset.id, existing),
    );
    const all = [...existing, ...added];
    const result = await dryRun(project, all, await savedResolutions(changeset.id), {
      table: fromTable,
      column: fkColumn,
    });
    const measured = result.measured ?? { total: from.rowCount ?? 0, filled: 0, empty: from.rowCount ?? 0 };
    const addedIds = new Set(added.map((i) => i.id));
    const conflicts = result.conflicts.filter((c) => addedIds.has(c.itemId)).length;
    return {
      id: changeset.id,
      items: added.map((item) => ({
        ...item,
        payload: item.payload as Record<string, unknown>,
        summary: describeChange(item.payload),
      })),
      sql: migrationSql(compileMigration(added, project.schema)),
      backfill: { path: pathText, total: measured.total, filled: measured.filled, empty: measured.empty },
      conflicts,
      message: pathText
        ? `Backfill fills ${measured.filled} of ${measured.total} ${fromTable} rows via ${pathText}; ${measured.empty} stay empty.`
        : hasColumn
          ? `${fromTable}.${fkColumn} exists; added the foreign key.`
          : `No foreign-key path from ${fromTable} to ${toTable}; ${fkColumn} starts empty and nullable.`,
    };
  },
});
