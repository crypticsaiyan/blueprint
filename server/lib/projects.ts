import { fail } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, asc, desc, eq } from "drizzle-orm";

import {
  projectSchema,
  type ChangeItem,
  type ProjectedSchema,
} from "../../shared/changes.js";
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
export function layoutTables(snapshot: SchemaSnapshot) {
  const depth = new Map<string, number>();
  const parents = (name: string) =>
    snapshot.tables
      .find((t) => t.name === name)
      ?.foreignKeys.map((fk) => fk.refTable)
      .filter((ref) => ref !== name) ?? [];
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
  // Left to right: parents in earlier columns. Heights follow column counts.
  const COL = 300;
  const GAP = 48;
  const height = (name: string) =>
    44 + 19 * (snapshot.tables.find((t) => t.name === name)?.columns.length ?? 4);
  for (const [d, names] of layers) {
    names.sort();
    const total = names.reduce((sum, n) => sum + height(n), 0) + GAP * (names.length - 1);
    let y = -total / 2;
    for (const name of names) {
      positions.set(name, { x: d * COL, y: Math.round(y) });
      y += height(name) + GAP;
    }
  }
  return positions;
}
