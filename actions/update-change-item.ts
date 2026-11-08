import { defineAction, fail } from "@agent-native/core/action";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  changePayloadSchema,
  describeChange,
  projectSchema,
  validateAgainst,
} from "../shared/changes.js";
import { getDb, schema } from "../server/db/index.js";
import { changeItemOutput } from "../server/lib/output-schemas.js";
import {
  loadItems,
  nowIso,
  requireProject,
  toChangeItem,
  touchChangeset,
} from "../server/lib/projects.js";

export default defineAction({
  description:
    "Accept, reject, edit, or lock one change item. Locked items survive replan-changeset: a locked accepted item is kept, a locked rejected item must not be proposed again. Pass only the fields to change.",
  schema: z.object({
    id: z.string().describe("Change item id"),
    status: z
      .enum(["proposed", "accepted", "rejected"])
      .optional()
      .describe('New status: "proposed", "accepted", or "rejected"'),
    locked: z.boolean().optional().describe("Lock or unlock the item"),
    reason: z.string().optional().describe("Replace the reason text"),
    change: changePayloadSchema
      .optional()
      .describe("Replacement change of the same kind, e.g. a table with more columns"),
  }),
  outputSchema: z.object({ item: changeItemOutput, message: z.string() }),
  run: async (args) => {
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.changeItems)
      .where(eq(schema.changeItems.id, args.id))
      .limit(1);
    if (!row) fail("Change item not found.", { errorCode: "item_not_found", statusCode: 404 });
    const project = await requireProject(row.projectId, "editor");
    if (args.change) {
      if (args.change.kind !== row.kind) {
        fail(`Edit must keep the kind "${row.kind}"; propose a new item instead.`, {
          errorCode: "kind_change",
        });
      }
      const others = (await loadItems(row.changesetId)).filter(
        (item) => item.id !== row.id && item.position < row.position,
      );
      const problem = validateAgainst(projectSchema(project.schema, others), args.change);
      if (problem) fail(problem, { errorCode: "invalid_change" });
    }
    const patch = {
      ...(args.status ? { status: args.status } : {}),
      ...(args.locked !== undefined ? { locked: args.locked } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.change ? { payload: args.change } : {}),
      updatedAt: nowIso(),
    };
    const [updated] = await db
      .update(schema.changeItems)
      .set(patch)
      .where(eq(schema.changeItems.id, row.id))
      .returning();
    if (!updated) fail("Change item was deleted.", { errorCode: "item_not_found", statusCode: 404 });
    await touchChangeset(row.changesetId);
    const item = toChangeItem(updated);
    const verbs = [
      args.status,
      args.locked === true ? "locked" : args.locked === false ? "unlocked" : null,
      args.change ? "edited" : null,
    ].filter(Boolean);
    return {
      item: { ...item, payload: item.payload as Record<string, unknown>, summary: describeChange(item.payload) },
      message: `${describeChange(item.payload)}: ${verbs.join(", ") || "updated"}.`,
    };
  },
});
