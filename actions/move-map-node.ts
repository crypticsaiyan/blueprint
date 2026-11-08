import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireProject, scopeOf } from "../server/lib/projects.js";

export default defineAction({
  description: "Save where a node sits on the canvas after the user drags it.",
  agentTool: false,
  parallelSafe: true,
  schema: z.object({
    projectId: z.string().describe("Project id"),
    key: z.string().describe('Node key, e.g. "table:users"'),
    x: z.number().describe("Canvas x"),
    y: z.number().describe("Canvas y"),
  }),
  outputSchema: z.object({ key: z.string(), x: z.number(), y: z.number() }),
  run: async ({ projectId, key, x, y }) => {
    const project = await requireProject(projectId, "editor");
    await getDb()
      .insert(schema.mapNodes)
      .values({
        id: crypto.randomUUID(),
        projectId,
        key,
        kind: key.startsWith("module:") ? "module" : "table",
        label: key.split(":").slice(1).join(":"),
        x,
        y,
        ...scopeOf(project),
      })
      .onConflictDoUpdate({
        target: [schema.mapNodes.projectId, schema.mapNodes.key],
        set: { x, y },
      });
    return { key, x, y };
  },
});
