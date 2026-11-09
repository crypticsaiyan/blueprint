import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import {
  describeChange,
  projectSchema,
  tableName,
  type ChangePayload,
} from "../shared/changes.js";
import { changeItemOutput } from "../server/lib/output-schemas.js";
import {
  insertItems,
  loadItems,
  nextPosition,
  openChangeset,
  requireProject,
} from "../server/lib/projects.js";

export default defineAction({
  description:
    "Create a new table drawn on the canvas. It starts as a ghost with an id primary key and created_at; then fill likely columns by editing the item with update-change-item.",
  schema: z.object({
    projectId: z.string().describe("Project id"),
    name: tableName.describe("New table name in the schema's existing style, e.g. orgs; schema.table outside public"),
    x: z.number().default(0).describe("Canvas x position"),
    y: z.number().default(0).describe("Canvas y position"),
  }),
  outputSchema: z.object({ id: z.string(), item: changeItemOutput, message: z.string() }),
  run: async ({ projectId, name, x, y }) => {
    const project = await requireProject(projectId, "editor");
    const changeset = await openChangeset(project);
    const items = await loadItems(changeset.id);
    if (projectSchema(project.schema, items).tables.some((t) => t.name === name)) {
      fail(`A table named "${name}" already exists.`, { errorCode: "table_exists", statusCode: 409 });
    }
    const payload: ChangePayload = {
      kind: "create_table",
      table: name,
      position: { x, y },
      columns: [
        { name: "id", type: "text", nullable: false, primaryKey: true },
        { name: "created_at", type: "timestamptz", nullable: false, default: "now()" },
      ],
    };
    const [item] = await insertItems(
      project,
      changeset.id,
      [{ payload, reason: "Drawn on the canvas.", origin: "drawing", status: "accepted" }],
      await nextPosition(changeset.id, items),
    );
    if (!item) throw new Error("draw-table inserted no item");
    return {
      id: item.id,
      item: { ...item, payload: item.payload as Record<string, unknown>, summary: describeChange(payload) },
      message: `Drew table ${name}. Its columns are a starting point.`,
    };
  },
});
