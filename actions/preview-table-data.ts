import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { q, qt, tableName } from "../shared/changes.js";
import { requireProject } from "../server/lib/projects.js";
import { sourceDb } from "../server/lib/sandbox.js";

export default defineAction({
  description:
    "Read sample rows from one table of a project's sample database (read-only). Use it to check real values before proposing a backfill or a constraint.",
  schema: z.object({
    projectId: z.string().describe("Project id"),
    table: tableName.describe("Table name; schema.table outside public"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Rows to return, 1-200; defaults to 50"),
  }),
  http: { method: "GET" },
  readOnly: true,
  outputSchema: z.object({
    table: z.string(),
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
  }),
  run: async ({ projectId, table, limit }) => {
    const project = await requireProject(projectId);
    const info = project.schema.tables.find((t) => t.name === table);
    if (!info) fail(`Table "${table}" is not in this project.`, { errorCode: "table_not_found", statusCode: 404 });
    const pg = await sourceDb(project.id, project.dumpPath);
    const order = info.primaryKey.length ? ` ORDER BY ${info.primaryKey.map(q).join(", ")}` : "";
    const rows = await pg.query<Record<string, unknown>>(
      `SELECT * FROM ${qt(table)}${order} LIMIT ${limit}`,
    );
    return {
      table,
      columns: info.columns.map((c) => c.name),
      rows: rows.rows,
      total: info.rowCount,
    };
  },
});
