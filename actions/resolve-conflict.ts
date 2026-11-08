import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { findOpenChangeset, loadItems, nowIso, requireProject } from "../server/lib/projects.js";
import { recordRehearsal } from "../server/lib/run-rehearsal.js";

export default defineAction({
  description:
    "Choose the fix for one rehearsal conflict, then re-run the rehearsal. Fixes: fill_value (needs value), delete_rows, set_null, merge_duplicates, rename_duplicates, skip. Use a fix listed for that conflict. Identify the conflict by id or by key (itemId:kind).",
  schema: z.object({
    projectId: z.string().describe("Project id"),
    conflict: z.string().describe("Conflict id, or key like <itemId>:duplicates"),
    fix: z
      .enum(["fill_value", "delete_rows", "set_null", "merge_duplicates", "rename_duplicates", "skip"])
      .describe("Fix to apply to the conflicting rows"),
    value: z.string().optional().describe("Value for fill_value"),
    rerun: z.boolean().default(true).describe("Re-run the rehearsal after saving; defaults to true"),
  }),
  outputSchema: z.object({
    id: z.string(),
    status: z.string(),
    rehearsalStatus: z.string().nullable(),
    fixResult: z.string().nullable(),
    openConflicts: z.number().nullable(),
    message: z.string(),
  }),
  run: async ({ projectId, conflict, fix, value, rerun }) => {
    const project = await requireProject(projectId, "editor");
    const changeset = await findOpenChangeset(projectId);
    if (!changeset) fail("No open changeset.", { errorCode: "empty_changeset" });
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.conflicts)
      .where(eq(schema.conflicts.changesetId, changeset.id))
      .limit(500);
    const row = rows.find((r) => r.id === conflict || r.key === conflict);
    if (!row) fail("Conflict not found. Rehearse first, then use an id from the result.", { errorCode: "conflict_not_found", statusCode: 404 });
    const option = row.detail.fixes.find((f) => f.id === fix);
    if (!option) {
      fail(`"${fix}" does not apply here. Choose one of: ${row.detail.fixes.map((f) => f.id).join(", ")}.`, {
        errorCode: "invalid_fix",
      });
    }
    if (option.needsValue && !value) fail("This fix needs a value.", { errorCode: "value_required" });
    await db
      .update(schema.conflicts)
      .set({ fix, fixValue: option.needsValue ? value! : null, status: "resolved", updatedAt: nowIso() })
      .where(and(eq(schema.conflicts.id, row.id), eq(schema.conflicts.changesetId, changeset.id)));

    if (!rerun) {
      return { id: row.id, status: "resolved", rehearsalStatus: null, fixResult: null, openConflicts: null, message: `Saved fix "${option.label}".` };
    }
    const { result } = await recordRehearsal(project, changeset.id, await loadItems(changeset.id));
    const report = result.conflicts.find((c) => c.key === row.key);
    const open = result.conflicts.filter((c) => !c.resolution).length;
    return {
      id: row.id,
      status: "resolved",
      rehearsalStatus: result.status,
      fixResult: report?.fixResult ?? null,
      openConflicts: open,
      message: `${option.label}: ${report?.fixResult ?? "applied"}. Rehearsal ${result.status}${open ? `, ${open} conflict${open === 1 ? "" : "s"} left` : ""}.`,
    };
  },
});
