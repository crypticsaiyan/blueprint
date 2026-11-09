import { defineAction } from "@agent-native/core/action";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { describeChange, planDependencies } from "../shared/changes.js";
import { getDb, schema } from "../server/db/index.js";
import {
  findOpenChangeset,
  loadItems,
  requireProject,
  touchChangeset,
} from "../server/lib/projects.js";

export default defineAction({
  description:
    "Start a re-plan: removes the agent's unlocked items and keeps locked items, the user's drawings, and the agent items those build on (the table a drawn foreign key points at, the column its backfill reads). Returns the goal and what was kept. Then call propose-changeset with a new plan that keeps locked accepted items and avoids locked rejected ones.",
  schema: z.object({
    projectId: z.string().describe("Project id"),
  }),
  outputSchema: z.object({
    id: z.string().nullable(),
    goal: z.string(),
    removed: z.number(),
    keep: z.array(z.object({ id: z.string(), summary: z.string(), status: z.string(), reason: z.string() })),
    avoid: z.array(z.object({ id: z.string(), summary: z.string(), reason: z.string() })),
    message: z.string(),
    nextRequiredAction: z.string().optional(),
  }),
  run: async ({ projectId }) => {
    await requireProject(projectId, "editor");
    const changeset = await findOpenChangeset(projectId);
    if (!changeset) {
      return { id: null, goal: "", removed: 0, keep: [], avoid: [], message: "No changeset to re-plan." };
    }
    const items = await loadItems(changeset.id);
    const pinned = new Set(items.filter((i) => i.locked || i.origin !== "agent").map((i) => i.id));
    const dependencies = planDependencies(items, pinned);
    const removable = items.filter((i) => !pinned.has(i.id) && !dependencies.has(i.id));
    if (removable.length) {
      await getDb()
        .delete(schema.changeItems)
        .where(
          and(
            eq(schema.changeItems.changesetId, changeset.id),
            inArray(
              schema.changeItems.id,
              removable.map((i) => i.id),
            ),
          ),
        );
      await touchChangeset(changeset.id);
    }
    const kept = items.filter((i) => !removable.includes(i));
    return {
      id: changeset.id,
      goal: changeset.goal,
      removed: removable.length,
      keep: kept
        .filter((i) => i.status !== "rejected")
        .map((i) => ({ id: i.id, summary: describeChange(i.payload), status: i.status, reason: i.reason })),
      avoid: kept
        .filter((i) => i.status === "rejected")
        .map((i) => ({ id: i.id, summary: describeChange(i.payload), reason: i.reason })),
      message:
        `Removed ${removable.length} unlocked item${removable.length === 1 ? "" : "s"}; kept ${kept.length}.` +
        (dependencies.size
          ? ` ${dependencies.size} of the kept items are earlier proposals that locked or drawn items build on; keep them and don't propose them again.`
          : ""),
      nextRequiredAction: "propose-changeset",
    };
  },
});
