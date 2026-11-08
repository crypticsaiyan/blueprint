import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { computeImpact } from "../shared/impact.js";
import { currentAnalysis } from "../server/lib/code-state.js";
import { findOpenChangeset, loadItems, requireProject } from "../server/lib/projects.js";

export default defineAction({
  description:
    "List the queries the open changeset affects, with file, line, function, and why: \"breaks\" (will fail at runtime, e.g. an insert missing a new NOT NULL column) or \"review\" (still runs but should change, e.g. a read that is not scoped by the new org_id). Reads the changeset's working copy once code has been edited.",
  schema: z.object({ projectId: z.string().describe("Project id") }),
  http: { method: "GET" },
  readOnly: true,
  outputSchema: z.object({
    adapter: z.string(),
    approximate: z.boolean(),
    breaks: z.number(),
    review: z.number(),
    impacts: z.array(
      z.object({
        module: z.string(),
        function: z.string(),
        line: z.number(),
        table: z.string(),
        operation: z.string(),
        severity: z.enum(["breaks", "review"]),
        reason: z.string(),
        snippet: z.string(),
        itemId: z.string(),
        approximate: z.boolean(),
      }),
    ),
  }),
  run: async ({ projectId }) => {
    const project = await requireProject(projectId);
    const changeset = await findOpenChangeset(projectId);
    const analysis = await currentAnalysis(project, changeset, { refresh: true });
    if (!analysis || !changeset) {
      return { adapter: analysis?.adapter ?? "none", approximate: false, breaks: 0, review: 0, impacts: [] };
    }
    const impacts = computeImpact(analysis, await loadItems(changeset.id));
    return {
      adapter: analysis.adapter,
      approximate: analysis.approximate,
      breaks: impacts.filter((i) => i.severity === "breaks").length,
      review: impacts.filter((i) => i.severity === "review").length,
      impacts: impacts.map(({ usageId: _usage, ...rest }) => rest),
    };
  },
});
