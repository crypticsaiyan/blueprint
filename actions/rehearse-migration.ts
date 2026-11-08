import { defineAction, fail } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { z } from "zod";

import { jsonObject } from "../server/lib/output-schemas.js";
import { findOpenChangeset, loadItems, requireProject } from "../server/lib/projects.js";
import { recordRehearsal, summarize } from "../server/lib/run-rehearsal.js";

export default defineAction({
  description:
    "Rehearse the open changeset: run its migration on a fresh copy of the sample data in PGlite, applying chosen conflict fixes. Reports each step, rows changed per table, and conflicts (duplicates blocking a unique index, NULLs blocking NOT NULL, orphaned foreign keys) with fix choices.",
  schema: z.object({ projectId: z.string().describe("Project id") }),
  outputSchema: z.object({
    id: z.string(),
    status: z.enum(["passed", "conflicts", "failed"]),
    summary: jsonObject,
    conflicts: z.array(
      z.object({
        key: z.string(),
        itemId: z.string(),
        kind: z.string(),
        table: z.string(),
        rowCount: z.number(),
        message: z.string(),
        fixes: z.array(z.string()),
        chosenFix: z.string().nullable(),
        fixResult: z.string().nullable(),
      }),
    ),
    message: z.string(),
    nextRequiredAction: z.string().optional(),
  }),
  link: ({ args }) => ({
    url: buildDeepLink({
      view: "rehearse",
      to: `/projects/${encodeURIComponent(args.projectId)}/rehearse`,
      params: { projectId: args.projectId },
    }),
    label: "Open rehearsal",
  }),
  run: async ({ projectId }) => {
    const project = await requireProject(projectId, "editor");
    const changeset = await findOpenChangeset(projectId);
    const items = changeset ? await loadItems(changeset.id) : [];
    if (!changeset || items.every((i) => i.status === "rejected")) {
      fail("Nothing to rehearse yet. Propose or draw a change first.", { errorCode: "empty_changeset" });
    }
    const { id, result } = await recordRehearsal(project, changeset.id, items);
    const open = result.conflicts.filter((c) => !c.resolution);
    return {
      id,
      status: result.status,
      summary: summarize(result) as unknown as Record<string, unknown>,
      conflicts: result.conflicts.map((c) => ({
        key: c.key,
        itemId: c.itemId,
        kind: c.kind,
        table: c.table,
        rowCount: c.rowCount,
        message: c.message,
        fixes: c.fixes.map((f) => f.id),
        chosenFix: c.resolution?.fix ?? null,
        fixResult: c.fixResult ?? null,
      })),
      message:
        result.status === "passed"
          ? `Rehearsal passed in ${result.durationMs} ms: ${result.steps.length} steps ran on the sample data.`
          : result.status === "conflicts"
            ? `Rehearsal found ${open.length} conflict${open.length === 1 ? "" : "s"} in the sample data.`
            : `Rehearsal failed: ${result.steps.find((s) => s.status === "error")?.error ?? "a step errored"}.`,
      nextRequiredAction: open.length ? "resolve-conflict" : undefined,
    };
  },
});
