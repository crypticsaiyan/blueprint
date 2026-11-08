import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireProject } from "../server/lib/projects.js";

export default defineAction({
  description: "Remove a module dependency rule.",
  schema: z.object({ projectId: z.string().describe("Project id"), id: z.string().describe("Rule id") }),
  outputSchema: z.object({ id: z.string(), message: z.string() }),
  run: async ({ projectId, id }) => {
    await requireProject(projectId, "editor");
    const deleted = await getDb()
      .delete(schema.rules)
      .where(and(eq(schema.rules.id, id), eq(schema.rules.projectId, projectId)))
      .returning({ id: schema.rules.id });
    if (!deleted.length) fail("Rule not found.", { errorCode: "rule_not_found", statusCode: 404 });
    return { id, message: "Rule removed." };
  },
});
