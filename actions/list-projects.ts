import { defineAction } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { desc } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description: "List imported Blueprint projects (repo plus sample database), newest first.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  outputSchema: z.object({
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        source: z.string(),
        repoUrl: z.string().nullable(),
        tables: z.number(),
        createdAt: z.string(),
      }),
    ),
  }),
  link: () => ({ url: buildDeepLink({ view: "projects", to: "/projects" }), label: "Open projects" }),
  run: async () => {
    const { projects, projectShares } = schema;
    const rows = await getDb()
      .select({
        id: projects.id,
        name: projects.name,
        source: projects.source,
        repoUrl: projects.repoUrl,
        schema: projects.schema,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(accessFilter(projects, projectShares))
      .orderBy(desc(projects.createdAt))
      .limit(100);
    return {
      projects: rows.map(({ schema: snapshot, ...row }) => ({
        ...row,
        tables: snapshot.tables.length,
      })),
    };
  },
});
