import { defineAction } from "@agent-native/core/action";
import { readAppState } from "@agent-native/core/application-state";
import { z } from "zod";

import { describeChange, projectSchema } from "../shared/changes.js";
import { findOpenChangeset, loadItems, requireProject } from "../server/lib/projects.js";

type Navigation = { view?: string; projectId?: string; selection?: string };

export default defineAction({
  description:
    "Read what the user is looking at: the view, the open project, and details of the selected table, relationship, change item, or conflict. Basic navigation is already in <current-screen>; use this for a fresh read of the selection.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = (await readAppState("navigation")) as Navigation | null;
    if (!navigation) return "No application state found. Is the app running?";
    const screen: Record<string, unknown> = { navigation };
    if (!navigation.projectId) return screen;

    const project = await requireProject(navigation.projectId);
    const changeset = await findOpenChangeset(project.id);
    const items = changeset ? await loadItems(changeset.id) : [];
    screen.project = { id: project.id, name: project.name, tables: project.schema.tables.length };
    screen.changeset = changeset
      ? { id: changeset.id, goal: changeset.goal, items: items.length }
      : null;

    const sel = navigation.selection ?? "";
    const [kind, ...rest] = sel.split(":");
    const ref = rest.join(":");
    if (kind === "table") {
      const table = projectSchema(project.schema, items).tables.find((t) => t.name === ref);
      const changes = items.filter((i) => "table" in i.payload && i.payload.table === ref);
      screen.selected = table
        ? {
            type: "table",
            name: table.name,
            rowCount: table.rowCount,
            ghost: Boolean(table.ghost),
            columns: table.columns.map((c) => `${c.name} ${c.type}${c.nullable ? "" : " not null"}${c.ghost ? " (proposed)" : ""}`),
            changes: changes.map((i) => ({ id: i.id, summary: describeChange(i.payload), status: i.status, locked: i.locked })),
          }
        : { type: "table", name: ref, missing: true };
    } else if (kind === "item") {
      const item = items.find((i) => i.id === ref);
      screen.selected = item
        ? { type: "item", ...item, summary: describeChange(item.payload) }
        : { type: "item", id: ref, missing: true };
    } else if (kind === "conflict" || kind === "edge") {
      screen.selected = { type: kind, ref };
    }
    return screen;
  },
});
