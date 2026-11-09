import { defineAction, fail } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { z } from "zod";

import {
  changePayloadSchema,
  compileMigration,
  describeChange,
  migrationSql,
  projectSchema,
  validateAgainst,
  type ChangeItem,
} from "../shared/changes.js";
import { changeItemOutput } from "../server/lib/output-schemas.js";
import {
  insertItems,
  loadItems,
  nextPosition,
  openChangeset,
  requireProject,
} from "../server/lib/projects.js";

const samePayload = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export default defineAction({
  description:
    "Add proposed schema changes (ghosts) to the project's open changeset, each with a one-line reason. Items are checked in order against the schema projected from earlier items. Kinds: create_table, add_column, set_not_null, add_unique, add_foreign_key, drop_foreign_key, backfill (SQL that fills data), add_index. Add NOT NULL columns with nullable:false and a backfill; the migration adds them nullable, runs backfills, then enforces NOT NULL.",
  schema: z.object({
    projectId: z.string().describe("Project id"),
    goal: z.string().min(1).describe('The user\'s goal in their words, e.g. "add multi-tenant orgs"'),
    items: z
      .array(
        z.object({
          change: changePayloadSchema,
          reason: z.string().min(1).describe("Why this change is needed, one sentence"),
        }),
      )
      .min(1)
      .max(40),
  }),
  outputSchema: z.object({
    id: z.string(),
    added: z.array(changeItemOutput),
    sql: z.string(),
    message: z.string(),
    nextRequiredAction: z.string().optional(),
  }),
  link: ({ args }) => ({
    url: buildDeepLink({
      view: "map",
      to: `/projects/${encodeURIComponent(args.projectId)}`,
      params: { projectId: args.projectId },
    }),
    label: "Open map",
  }),
  run: async ({ projectId, goal, items }) => {
    const project = await requireProject(projectId, "editor");
    const changeset = await openChangeset(project, goal);
    const existing = await loadItems(changeset.id);
    const lockedRejected = existing.filter((i) => i.locked && i.status === "rejected");
    const working: ChangeItem[] = [...existing];
    let position = await nextPosition(changeset.id, existing);
    // A re-plan keeps items the agent may list again; adding them twice is a no-op, not an error.
    const fresh = items.filter(
      (entry) => !existing.some((i) => i.status !== "rejected" && samePayload(i.payload, entry.change)),
    );
    const skipped = items.length - fresh.length;
    for (const [index, entry] of items.entries()) {
      if (!fresh.includes(entry)) continue;
      if (lockedRejected.some((r) => samePayload(r.payload, entry.change))) {
        fail(
          `Item ${index + 1} (${describeChange(entry.change)}) repeats a change the user rejected and locked. Plan around it.`,
          { errorCode: "locked_rejection" },
        );
      }
      const problem = validateAgainst(projectSchema(project.schema, working), entry.change);
      if (problem) {
        const already = / already exists\.$/.test(problem)
          ? " It is already in the schema or the changeset (see get-project-map); build on it instead of adding it again."
          : "";
        fail(`Item ${index + 1} (${describeChange(entry.change)}): ${problem}${already}`, {
          errorCode: "invalid_change",
        });
      }
      working.push({
        id: `pending-${index}`,
        kind: entry.change.kind,
        payload: entry.change,
        reason: entry.reason,
        status: "proposed",
        locked: false,
        origin: "agent",
        position: position++,
      });
    }
    const added = await insertItems(
      project,
      changeset.id,
      fresh.map((entry) => ({ payload: entry.change, reason: entry.reason, origin: "agent" as const })),
      await nextPosition(changeset.id, existing),
    );
    const all = [...existing, ...added];
    return {
      id: changeset.id,
      added: added.map((item) => ({
        ...item,
        payload: item.payload as Record<string, unknown>,
        summary: describeChange(item.payload),
      })),
      sql: migrationSql(compileMigration(all, project.schema)),
      message:
        `Added ${added.length} proposed change${added.length === 1 ? "" : "s"} to the changeset.` +
        (skipped ? ` Skipped ${skipped} already in it.` : ""),
      nextRequiredAction: "rehearse-migration",
    };
  },
});
