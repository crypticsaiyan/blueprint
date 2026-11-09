import { defineAction } from "@agent-native/core/action";
import { assertAccess } from "@agent-native/core/sharing";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { removeCheckout } from "../server/lib/import.js";
import { requireProject } from "../server/lib/projects.js";
import { dropSource } from "../server/lib/sandbox.js";
import { removeMaterializedSource } from "../server/lib/schema-source.js";
import { removeWorkspace } from "../server/lib/workspace.js";

export default defineAction({
  description:
    "Delete a project for good: its map, changesets, rehearsals, test runs and rules, plus the cloned repo and working copies on disk. Pull requests already opened on GitHub stay open. Always ask the user to confirm first.",
  schema: z.object({ projectId: z.string().describe("Project id") }),
  outputSchema: z.object({ id: z.string(), name: z.string(), message: z.string() }),
  run: async ({ projectId }) => {
    const project = await requireProject(projectId);
    await assertAccess("project", projectId, "admin");
    const db = getDb();
    const changesets = await db
      .select({ id: schema.changesets.id })
      .from(schema.changesets)
      .where(eq(schema.changesets.projectId, projectId));
    const ids = changesets.map((c) => c.id);
    // Children first; nothing here has database-level foreign keys, but the
    // order keeps a half-finished delete from leaving orphans behind a project.
    for (const table of [
      schema.pullRequests,
      schema.testRuns,
      schema.codeEdits,
      schema.conflicts,
      schema.rehearsals,
      schema.changeItems,
    ]) {
      await db.delete(table).where(eq(table.projectId, projectId));
    }
    if (ids.length) await db.delete(schema.changesets).where(inArray(schema.changesets.id, ids));
    await db.delete(schema.rules).where(eq(schema.rules.projectId, projectId));
    await db.delete(schema.mapEdges).where(eq(schema.mapEdges.projectId, projectId));
    await db.delete(schema.mapNodes).where(eq(schema.mapNodes.projectId, projectId));
    await db.delete(schema.projectShares).where(eq(schema.projectShares.resourceId, projectId));
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));

    dropSource(projectId);
    // Files go after the rows: a failed delete leaves a project that still opens.
    await Promise.all(ids.map((id) => removeWorkspace(id)));
    await removeMaterializedSource(project.dumpPath);
    if (project.source === "github") await removeCheckout(project.repoPath);
    return { id: projectId, name: project.name, message: `Deleted ${project.name}.` };
  },
});
