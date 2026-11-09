import { defineAction } from "@agent-native/core/action";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { layoutModules, layoutTables, requireProject, scopeOf } from "../server/lib/projects.js";

export default defineAction({
  description:
    "Tidy the map: lay tables out again by foreign-key depth (parents left of children) and put code modules back above them. Replaces positions the user dragged; ask before using it on a map they arranged by hand.",
  schema: z.object({ projectId: z.string().describe("Project id") }),
  outputSchema: z.object({ tables: z.number(), modules: z.number(), message: z.string() }),
  run: async ({ projectId }) => {
    const project = await requireProject(projectId, "editor");
    const tables = layoutTables(project.schema);
    const modules = layoutModules(project.code?.modules ?? [], tables);
    const rows = [
      ...[...tables].map(([name, p]) => ({ key: `table:${name}`, kind: "table" as const, label: name, ...p })),
      ...[...modules].map(([path, p]) => ({ key: `module:${path}`, kind: "module" as const, label: path, ...p })),
    ];
    if (rows.length) {
      await getDb()
        .insert(schema.mapNodes)
        .values(rows.map((r) => ({ id: crypto.randomUUID(), projectId, ...r, ...scopeOf(project) })))
        .onConflictDoUpdate({
          target: [schema.mapNodes.projectId, schema.mapNodes.key],
          set: { x: sql`excluded.x`, y: sql`excluded.y` },
        });
    }
    return {
      tables: tables.size,
      modules: modules.size,
      message: `Arranged ${tables.size} tables${modules.size ? ` and ${modules.size} modules` : ""}.`,
    };
  },
});
