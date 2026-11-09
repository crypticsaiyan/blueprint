import { fail } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, asc, desc, eq } from "drizzle-orm";

import {
  projectSchema,
  type ChangeItem,
  type ProjectedSchema,
} from "../../shared/changes.js";
import { COMPACT_TABLES } from "../../shared/map-layout.js";
import type { SchemaSnapshot } from "../../shared/schema-types.js";
import { getDb, schema } from "../db/index.js";

/** Timestamps are ISO strings so text comparison is time order. */
export const nowIso = () => new Date().toISOString();

export type ProjectRow = typeof schema.projects.$inferSelect;
export type ChangesetRow = typeof schema.changesets.$inferSelect;

export async function requireProject(
  projectId: string,
  role: "viewer" | "editor" = "viewer",
): Promise<ProjectRow> {
  const { projects, projectShares } = schema;
  const [project] = await getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), accessFilter(projects, projectShares, undefined, role)))
    .limit(1);
  if (!project) {
    fail("Project not found, or you do not have access to it.", {
      errorCode: "project_not_found",
      statusCode: 404,
    });
  }
  return project;
}

export function scopeOf(project: ProjectRow) {
  return { ownerEmail: project.ownerEmail, orgId: project.orgId };
}

export async function findOpenChangeset(projectId: string): Promise<ChangesetRow | null> {
  const [row] = await getDb()
    .select()
    .from(schema.changesets)
    .where(
      and(
        eq(schema.changesets.projectId, projectId),
        eq(schema.changesets.status, "open"),
      ),
    )
    .orderBy(desc(schema.changesets.createdAt))
    .limit(1);
  return row ?? null;
}

export async function openChangeset(
  project: ProjectRow,
  goal?: string,
): Promise<ChangesetRow> {
  const existing = await findOpenChangeset(project.id);
  if (existing) {
    if (goal && goal !== existing.goal) {
      await getDb()
        .update(schema.changesets)
        .set({ goal, updatedAt: nowIso() })
        .where(eq(schema.changesets.id, existing.id));
      return { ...existing, goal };
    }
    return existing;
  }
  const row = {
    id: crypto.randomUUID(),
    projectId: project.id,
    goal: goal ?? "",
    status: "open" as const,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...scopeOf(project),
  };
  await getDb().insert(schema.changesets).values(row);
  const [created] = await getDb()
    .select()
    .from(schema.changesets)
    .where(eq(schema.changesets.id, row.id));
  if (!created) throw new Error("Changeset insert was not readable");
  return created;
}

export function toChangeItem(row: typeof schema.changeItems.$inferSelect): ChangeItem {
  return {
    id: row.id,
    kind: row.payload.kind,
    payload: row.payload,
    reason: row.reason,
    status: row.status,
    locked: row.locked,
    origin: row.origin,
    position: row.position,
  };
}

export async function loadItems(changesetId: string): Promise<ChangeItem[]> {
  const rows = await getDb()
    .select()
    .from(schema.changeItems)
    .where(eq(schema.changeItems.changesetId, changesetId))
    .orderBy(asc(schema.changeItems.position))
    .limit(500);
  return rows.map(toChangeItem);
}

export async function projected(
  project: ProjectRow,
  changesetId: string | null,
): Promise<{ items: ChangeItem[]; projected: ProjectedSchema }> {
  const items = changesetId ? await loadItems(changesetId) : [];
  return { items, projected: projectSchema(project.schema, items) };
}

export async function nextPosition(changesetId: string, items?: ChangeItem[]) {
  const list = items ?? (await loadItems(changesetId));
  return list.reduce((max, item) => Math.max(max, item.position), 0) + 1;
}

export async function insertItems(
  project: ProjectRow,
  changesetId: string,
  entries: {
    payload: ChangeItem["payload"];
    reason: string;
    origin: ChangeItem["origin"];
    status?: ChangeItem["status"];
  }[],
  start: number,
): Promise<ChangeItem[]> {
  const rows = entries.map((entry, index) => ({
    id: crypto.randomUUID(),
    changesetId,
    projectId: project.id,
    kind: entry.payload.kind,
    payload: entry.payload,
    reason: entry.reason,
    status: entry.status ?? ("proposed" as const),
    locked: false,
    origin: entry.origin,
    position: start + index,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...scopeOf(project),
  }));
  if (rows.length) await getDb().insert(schema.changeItems).values(rows);
  await touchChangeset(changesetId);
  return rows.map(toChangeItem);
}

export async function touchChangeset(changesetId: string) {
  await getDb()
    .update(schema.changesets)
    .set({ updatedAt: nowIso() })
    .where(eq(schema.changesets.id, changesetId));
}

/**
 * Lays tables out in layers by foreign-key depth, parents left of children,
 * so the map reads like the data model.
 */
/** Rows a compact table card shows: its key and any proposed columns. */
const compactRows = (table: { primaryKey: string[] }) => Math.max(1, table.primaryKey.length) + 1;

/**
 * Lays tables out left to right by foreign-key depth: parents in earlier
 * columns. Large schemas use compact card heights and wrap each depth into
 * several columns, so the map stays wide rather than one tall strip.
 */
export function layoutTables(snapshot: SchemaSnapshot) {
  const byName = new Map(snapshot.tables.map((t) => [t.name, t]));
  const compact = snapshot.tables.length > COMPACT_TABLES;
  const depth = new Map<string, number>();
  const parents = (name: string) =>
    byName.get(name)?.foreignKeys.map((fk) => fk.refTable).filter((ref) => ref !== name && byName.has(ref)) ?? [];
  const visit = (name: string, trail: Set<string>): number => {
    if (depth.has(name)) return depth.get(name)!;
    if (trail.has(name)) return 0;
    trail.add(name);
    const d = Math.max(-1, ...parents(name).map((p) => visit(p, trail))) + 1;
    trail.delete(name);
    depth.set(name, d);
    return d;
  };
  snapshot.tables.forEach((t) => visit(t.name, new Set()));
  const layers = new Map<number, string[]>();
  for (const [name, d] of depth) layers.set(d, [...(layers.get(d) ?? []), name]);
  const positions = new Map<string, { x: number; y: number }>();
  const COL = 300;
  const GAP = compact ? 28 : 48;
  const height = (name: string) => {
    const table = byName.get(name);
    return 44 + 19 * (compact && table ? compactRows(table) : (table?.columns.length ?? 4));
  };
  // Tables sharing a parent sit together within their column.
  const firstParent = (name: string) => parents(name).sort()[0] ?? "";
  // Columns tall enough that the whole map is about as wide as it is tall
  // (cards are ~300 wide, ~110 tall), which is the canvas's own shape.
  const perColumn = compact ? Math.max(6, Math.ceil(Math.sqrt(snapshot.tables.length / 0.44))) : Infinity;
  let x = 0;
  for (const d of [...layers.keys()].sort((a, b) => a - b)) {
    const names = layers.get(d)!.sort((a, b) => firstParent(a).localeCompare(firstParent(b)) || a.localeCompare(b));
    for (let start = 0; start < names.length; start += perColumn) {
      const column = names.slice(start, start + perColumn);
      const total = column.reduce((sum, n) => sum + height(n), 0) + GAP * (column.length - 1);
      let y = -total / 2;
      for (const name of column) {
        positions.set(name, { x, y: Math.round(y) });
        y += height(name) + GAP;
      }
      x += COL;
    }
  }
  return positions;
}

/** Places code modules in rows above the tables. */
export function layoutModules(
  modules: { path: string }[],
  tablePositions: Map<string, { x: number; y: number }>,
) {
  const xs = [...tablePositions.values()].map((p) => p.x);
  const ys = [...tablePositions.values()].map((p) => p.y);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) + 240 : 1200;
  const top = ys.length ? Math.min(...ys) : 0;
  const perRow = Math.max(1, Math.min(modules.length, Math.floor((maxX - minX + 40) / 230) || 1));
  const rows = Math.ceil(modules.length / perRow);
  const out = new Map<string, { x: number; y: number }>();
  modules.forEach((module, index) => {
    const row = Math.floor(index / perRow);
    const col = index % perRow;
    out.set(module.path, { x: minX + col * 230, y: top - 120 - (rows - row) * 90 });
  });
  return out;
}
