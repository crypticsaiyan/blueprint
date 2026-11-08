import { defineAction } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { describeChange, type ChangeItem } from "../shared/changes.js";
import type { SchemaSnapshot } from "../shared/schema-types.js";
import { getDb, schema } from "../server/db/index.js";
import { changeItemOutput, jsonObject } from "../server/lib/output-schemas.js";
import { findOpenChangeset, loadItems, requireProject } from "../server/lib/projects.js";

export default defineAction({
  description:
    "Read a project's map: every table with columns, keys, foreign keys and row counts (read from the sample Postgres database), code modules with the queries they run (file, line, table, columns), dependency rules, canvas positions, and the open changeset's items. Call this before proposing changes.",
  schema: z.object({
    projectId: z.string().describe("Project id from list-projects or the current screen"),
  }),
  http: { method: "GET" },
  readOnly: true,
  outputSchema: z.object({
    project: z.object({
      id: z.string(),
      name: z.string(),
      source: z.string(),
      repoUrl: z.string().nullable(),
    }),
    schema: jsonObject,
    code: jsonObject.nullable(),
    rules: z.array(z.object({ id: z.string(), fromModule: z.string(), toModule: z.string(), reason: z.string() })),
    positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
    changeset: z
      .object({
        id: z.string(),
        goal: z.string(),
        items: z.array(changeItemOutput),
        rehearsal: z
          .object({ id: z.string(), status: z.string(), createdAt: z.string(), stale: z.boolean() })
          .nullable(),
      })
      .nullable(),
  }),
  link: ({ args }) => ({
    url: buildDeepLink({
      view: "map",
      to: `/projects/${encodeURIComponent(args.projectId)}`,
      params: { projectId: args.projectId },
    }),
    label: "Open map",
  }),
  run: async ({ projectId }) => {
    const project = await requireProject(projectId);
    const nodes = await getDb()
      .select({ key: schema.mapNodes.key, x: schema.mapNodes.x, y: schema.mapNodes.y })
      .from(schema.mapNodes)
      .where(eq(schema.mapNodes.projectId, projectId))
      .limit(1000);
    const changeset = await findOpenChangeset(projectId);
    let changesetOut = null;
    if (changeset) {
      const items = await loadItems(changeset.id);
      const [rehearsal] = await getDb()
        .select({
          id: schema.rehearsals.id,
          status: schema.rehearsals.status,
          createdAt: schema.rehearsals.createdAt,
        })
        .from(schema.rehearsals)
        .where(eq(schema.rehearsals.changesetId, changeset.id))
        .orderBy(desc(schema.rehearsals.createdAt))
        .limit(1);
      changesetOut = {
        id: changeset.id,
        goal: changeset.goal,
        items: items.map(withSummary),
        rehearsal: rehearsal
          ? { ...rehearsal, stale: rehearsal.createdAt < changeset.updatedAt }
          : null,
      };
    }
    return {
      project: {
        id: project.id,
        name: project.name,
        source: project.source,
        repoUrl: project.repoUrl,
      },
      schema: project.schema as SchemaSnapshot as unknown as Record<string, unknown>,
      code: ((changeset?.code ?? project.code) as unknown as Record<string, unknown> | null) ?? null,
      rules: await getDb()
        .select({
          id: schema.rules.id,
          fromModule: schema.rules.fromModule,
          toModule: schema.rules.toModule,
          reason: schema.rules.reason,
        })
        .from(schema.rules)
        .where(eq(schema.rules.projectId, projectId))
        .limit(200),
      positions: Object.fromEntries(nodes.map((n) => [n.key, { x: n.x, y: n.y }])),
      changeset: changesetOut,
    };
  },
});

function withSummary(item: ChangeItem) {
  return { ...item, payload: item.payload as Record<string, unknown>, summary: describeChange(item.payload) };
}
