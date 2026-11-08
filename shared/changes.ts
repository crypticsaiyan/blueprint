import { z } from "zod";

import type { ColumnInfo, SchemaSnapshot, TableInfo } from "./schema-types";

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
// Types are spliced into DDL, so only plain Postgres type names are allowed.
const TYPE = /^[a-z][a-z0-9_ ]*(\(\d+(,\s*\d+)?\))?(\[\])?$/i;
// Defaults are expressions; forbid statement breaks and comments.
const DEFAULT_EXPR = /^[^;]*$/;

export const identifier = z
  .string()
  .regex(IDENT, "Use lowercase snake_case identifiers (a-z, 0-9, _).");

export const columnSpecSchema = z.object({
  name: identifier.describe("Column name, snake_case"),
  type: z
    .string()
    .regex(TYPE, "Use a plain Postgres type such as text, integer, timestamptz.")
    .describe("Postgres type, e.g. text, integer, bigint, timestamptz, boolean, jsonb"),
  nullable: z
    .boolean()
    .default(true)
    .describe("Whether NULL is allowed; defaults to true"),
  default: z
    .string()
    .regex(DEFAULT_EXPR)
    .nullable()
    .optional()
    .describe("SQL default expression, e.g. now() or 'active'"),
  primaryKey: z.boolean().optional().describe("True for the primary key column"),
  references: z
    .object({
      table: identifier,
      column: identifier,
      onDelete: z
        .enum(["no action", "cascade", "set null", "restrict"])
        .default("no action"),
    })
    .optional()
    .describe("Foreign key target for this column"),
});
export type ColumnSpec = z.infer<typeof columnSpecSchema>;

const position = z
  .object({ x: z.number(), y: z.number() })
  .optional()
  .describe("Canvas position for a drawn table");

export const changePayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create_table"),
    table: identifier,
    columns: z.array(columnSpecSchema).min(1),
    position,
  }),
  z.object({
    kind: z.literal("add_column"),
    table: identifier,
    column: columnSpecSchema,
  }),
  z.object({
    kind: z.literal("set_not_null"),
    table: identifier,
    column: identifier,
  }),
  z.object({
    kind: z.literal("add_unique"),
    table: identifier,
    columns: z.array(identifier).min(1),
    caseInsensitive: z
      .boolean()
      .default(false)
      .describe("Compare text with lower(); use for emails"),
  }),
  z.object({
    kind: z.literal("add_foreign_key"),
    table: identifier,
    column: identifier,
    refTable: identifier,
    refColumn: identifier,
    onDelete: z
      .enum(["no action", "cascade", "set null", "restrict"])
      .default("no action"),
  }),
  z.object({
    kind: z.literal("drop_foreign_key"),
    table: identifier,
    column: identifier,
    refTable: identifier,
    constraint: identifier.describe("Existing constraint name"),
  }),
  z.object({
    kind: z.literal("backfill"),
    table: identifier,
    column: identifier.optional(),
    sql: z
      .string()
      .min(1)
      .describe("One or more SQL statements that fill data, run inside the rehearsal"),
  }),
  z.object({
    kind: z.literal("add_index"),
    table: identifier,
    columns: z.array(identifier).min(1),
  }),
]);
export type ChangePayload = z.infer<typeof changePayloadSchema>;
export type ChangeKind = ChangePayload["kind"];

export type ItemStatus = "proposed" | "accepted" | "rejected";

export interface ChangeItem {
  id: string;
  kind: ChangeKind;
  payload: ChangePayload;
  reason: string;
  status: ItemStatus;
  locked: boolean;
  origin: "agent" | "drawing" | "user";
  position: number;
}

/** Items that are part of the plan: everything not rejected. */
export function activeItems<T extends Pick<ChangeItem, "status">>(items: T[]): T[] {
  return items.filter((item) => item.status !== "rejected");
}

export function describeChange(payload: ChangePayload): string {
  switch (payload.kind) {
    case "create_table":
      return `Create table ${payload.table}`;
    case "add_column":
      return `Add ${payload.table}.${payload.column.name} (${payload.column.type}${payload.column.nullable ? "" : ", not null"})`;
    case "set_not_null":
      return `Make ${payload.table}.${payload.column} NOT NULL`;
    case "add_unique":
      return `Unique ${payload.caseInsensitive ? "lower(" : ""}${payload.table}.${payload.columns.join(", ")}${payload.caseInsensitive ? ")" : ""}`;
    case "add_foreign_key":
      return `Foreign key ${payload.table}.${payload.column} → ${payload.refTable}.${payload.refColumn}`;
    case "drop_foreign_key":
      return `Drop foreign key ${payload.table}.${payload.column} → ${payload.refTable}`;
    case "backfill":
      return `Backfill ${payload.table}${payload.column ? `.${payload.column}` : ""}`;
    case "add_index":
      return `Index ${payload.table} (${payload.columns.join(", ")})`;
  }
}

// ---------------------------------------------------------------------------
// Projected schema: the current schema with active items applied, each piece
// tagged with the item that introduces it. The canvas draws ghosts from this.

export interface GhostTag {
  itemId: string;
  status: ItemStatus;
  locked: boolean;
}

export interface ProjectedColumn extends ColumnInfo {
  ghost?: GhostTag | undefined;
  /** Ghost constraints on an existing column (NOT NULL, unique). */
  ghostConstraints?: { label: string; tag: GhostTag }[] | undefined;
  isPrimaryKey: boolean;
}

export interface ProjectedEdge {
  id: string;
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  constraint: string | null;
  ghost?: GhostTag | undefined;
  /** Set when an item drops this existing relationship. */
  dropped?: GhostTag | undefined;
}

export interface ProjectedTable {
  name: string;
  columns: ProjectedColumn[];
  rowCount: number | null;
  ghost?: GhostTag | undefined;
  backfills: GhostTag[];
  position?: { x: number; y: number } | undefined;
}

export interface ProjectedSchema {
  tables: ProjectedTable[];
  edges: ProjectedEdge[];
}

function tag(item: ChangeItem): GhostTag {
  return { itemId: item.id, status: item.status, locked: item.locked };
}

export function projectSchema(
  snapshot: SchemaSnapshot,
  items: ChangeItem[],
): ProjectedSchema {
  const tables: ProjectedTable[] = snapshot.tables.map((table) => ({
    name: table.name,
    rowCount: table.rowCount,
    backfills: [],
    columns: table.columns.map((column) => ({
      ...column,
      isPrimaryKey: table.primaryKey.includes(column.name),
    })),
  }));
  const edges: ProjectedEdge[] = snapshot.tables.flatMap((table) =>
    table.foreignKeys
      .filter((fk) => fk.columns.length === 1)
      .map((fk) => ({
        id: `fk:${table.name}.${fk.columns[0]}->${fk.refTable}`,
        table: table.name,
        column: fk.columns[0]!,
        refTable: fk.refTable,
        refColumn: fk.refColumns[0]!,
        constraint: fk.name,
      })),
  );
  const byName = (name: string) => tables.find((table) => table.name === name);
  const addEdge = (
    item: ChangeItem,
    table: string,
    column: string,
    refTable: string,
    refColumn: string,
  ) => {
    edges.push({
      id: `ghost:${item.id}:${table}.${column}`,
      table,
      column,
      refTable,
      refColumn,
      constraint: null,
      ghost: tag(item),
    });
  };

  for (const item of [...activeItems(items)].sort((a, b) => a.position - b.position)) {
    const p = item.payload;
    switch (p.kind) {
      case "create_table": {
        if (byName(p.table)) break;
        tables.push({
          name: p.table,
          rowCount: null,
          ghost: tag(item),
          backfills: [],
          position: p.position,
          columns: p.columns.map((column) => ({
            name: column.name,
            type: column.type,
            nullable: column.primaryKey ? false : column.nullable,
            default: column.default ?? null,
            isPrimaryKey: Boolean(column.primaryKey),
            ghost: tag(item),
          })),
        });
        for (const column of p.columns) {
          if (column.references) {
            addEdge(item, p.table, column.name, column.references.table, column.references.column);
          }
        }
        break;
      }
      case "add_column": {
        const table = byName(p.table);
        if (!table || table.columns.some((c) => c.name === p.column.name)) break;
        table.columns.push({
          name: p.column.name,
          type: p.column.type,
          nullable: p.column.nullable,
          default: p.column.default ?? null,
          isPrimaryKey: false,
          ghost: tag(item),
        });
        if (p.column.references) {
          addEdge(item, p.table, p.column.name, p.column.references.table, p.column.references.column);
        }
        break;
      }
      case "set_not_null":
      case "add_unique": {
        const table = byName(p.table);
        const names = p.kind === "set_not_null" ? [p.column] : p.columns;
        for (const name of names) {
          const column = table?.columns.find((c) => c.name === name);
          if (!column) continue;
          column.ghostConstraints = [
            ...(column.ghostConstraints ?? []),
            {
              label:
                p.kind === "set_not_null"
                  ? "NOT NULL"
                  : p.caseInsensitive
                    ? "UNIQUE (ci)"
                    : "UNIQUE",
              tag: tag(item),
            },
          ];
        }
        break;
      }
      case "add_foreign_key":
        addEdge(item, p.table, p.column, p.refTable, p.refColumn);
        break;
      case "drop_foreign_key": {
        const edge = edges.find(
          (e) => !e.ghost && e.table === p.table && e.column === p.column && e.refTable === p.refTable,
        );
        if (edge) edge.dropped = tag(item);
        break;
      }
      case "backfill":
        byName(p.table)?.backfills.push(tag(item));
        break;
      case "add_index":
        break;
    }
  }
  return { tables, edges };
}

/**
 * Checks that an item makes sense against the schema projected from the items
 * before it. Returns a message the agent can act on, or null.
 */
export function validateAgainst(
  projected: ProjectedSchema,
  payload: ChangePayload,
): string | null {
  const table = (name: string) => projected.tables.find((t) => t.name === name);
  const column = (t: string, c: string) =>
    table(t)?.columns.find((col) => col.name === c);
  const needTable = (name: string) =>
    table(name) ? null : `Table "${name}" does not exist in the projected schema.`;
  const needColumn = (t: string, c: string) =>
    needTable(t) ?? (column(t, c) ? null : `Column "${t}.${c}" does not exist.`);

  switch (payload.kind) {
    case "create_table": {
      if (table(payload.table)) return `Table "${payload.table}" already exists.`;
      if (!payload.columns.some((c) => c.primaryKey)) {
        return `Table "${payload.table}" needs a primary key column.`;
      }
      for (const c of payload.columns) {
        if (c.references) {
          const problem =
            c.references.table === payload.table
              ? null
              : needColumn(c.references.table, c.references.column);
          if (problem) return problem;
        }
      }
      return null;
    }
    case "add_column":
      if (column(payload.table, payload.column.name)) {
        return `Column "${payload.table}.${payload.column.name}" already exists.`;
      }
      if (payload.column.references) {
        return (
          needTable(payload.table) ??
          needColumn(payload.column.references.table, payload.column.references.column)
        );
      }
      return needTable(payload.table);
    case "set_not_null":
      return needColumn(payload.table, payload.column);
    case "add_unique":
    case "add_index":
      for (const c of payload.columns) {
        const problem = needColumn(payload.table, c);
        if (problem) return problem;
      }
      return null;
    case "add_foreign_key":
      return (
        needColumn(payload.table, payload.column) ??
        needColumn(payload.refTable, payload.refColumn)
      );
    case "drop_foreign_key":
      return projected.edges.some(
        (e) =>
          !e.ghost &&
          e.table === payload.table &&
          e.column === payload.column &&
          e.refTable === payload.refTable,
      )
        ? null
        : `No relationship ${payload.table}.${payload.column} → ${payload.refTable} exists.`;
    case "backfill":
      return payload.column
        ? needColumn(payload.table, payload.column)
        : needTable(payload.table);
  }
}

// ---------------------------------------------------------------------------
// Migration compiler. Steps run in phase order so data can be filled between
// adding a column and enforcing it, and constraints land after backfills.

export type StepCheck =
  | { type: "not_null"; table: string; column: string }
  | { type: "unique"; table: string; columns: string[]; caseInsensitive: boolean }
  | {
      type: "foreign_key";
      table: string;
      column: string;
      refTable: string;
      refColumn: string;
    };

export interface MigrationStep {
  itemId: string;
  phase: number;
  label: string;
  sql: string;
  check?: StepCheck | undefined;
}

export const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

function columnDdl(column: ColumnSpec, forceNullable: boolean): string {
  const parts = [q(column.name), column.type];
  if (column.primaryKey) parts.push("PRIMARY KEY");
  if (column.default) parts.push(`DEFAULT ${column.default}`);
  if (!column.primaryKey && !column.nullable && !forceNullable) parts.push("NOT NULL");
  return parts.join(" ");
}

function fkName(table: string, column: string) {
  return `${table}_${column}_fkey`.slice(0, 63);
}

function fkStep(
  itemId: string,
  table: string,
  column: string,
  refTable: string,
  refColumn: string,
  onDelete: string,
): MigrationStep {
  const action = onDelete === "no action" ? "" : ` ON DELETE ${onDelete.toUpperCase()}`;
  return {
    itemId,
    phase: 6,
    label: `Foreign key ${table}.${column} → ${refTable}.${refColumn}`,
    sql: `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(fkName(table, column))} FOREIGN KEY (${q(column)}) REFERENCES ${q(refTable)} (${q(refColumn)})${action};`,
    check: { type: "foreign_key", table, column, refTable, refColumn },
  };
}

function notNullStep(itemId: string, table: string, column: string): MigrationStep {
  return {
    itemId,
    phase: 4,
    label: `Enforce ${table}.${column} NOT NULL`,
    sql: `ALTER TABLE ${q(table)} ALTER COLUMN ${q(column)} SET NOT NULL;`,
    check: { type: "not_null", table, column },
  };
}

/** Foreign-key depth per table: tables nothing references-up from are 0. */
function tableDepths(projected: ProjectedSchema): Map<string, number> {
  const depth = new Map<string, number>();
  const visit = (name: string, trail: Set<string>): number => {
    const known = depth.get(name);
    if (known !== undefined) return known;
    if (trail.has(name)) return 0;
    trail.add(name);
    const parents = projected.edges
      .filter((e) => e.table === name && e.refTable !== name && !e.dropped)
      .map((e) => visit(e.refTable, trail));
    trail.delete(name);
    const d = parents.length ? Math.max(...parents) + 1 : 0;
    depth.set(name, d);
    return d;
  };
  projected.tables.forEach((t) => visit(t.name, new Set()));
  return depth;
}

/**
 * Compiles items into ordered steps. With the base snapshot, backfills run
 * parents first, because child rows usually copy values from their parents.
 */
export function compileMigration(
  items: ChangeItem[],
  snapshot?: SchemaSnapshot,
): MigrationStep[] {
  const depths = snapshot ? tableDepths(projectSchema(snapshot, items)) : new Map<string, number>();
  const steps: MigrationStep[] = [];
  const ordered = [...activeItems(items)].sort((a, b) => a.position - b.position);
  for (const item of ordered) {
    const p = item.payload;
    switch (p.kind) {
      case "drop_foreign_key":
        steps.push({
          itemId: item.id,
          phase: 0,
          label: `Drop foreign key ${p.table}.${p.column} → ${p.refTable}`,
          sql: `ALTER TABLE ${q(p.table)} DROP CONSTRAINT ${q(p.constraint)};`,
        });
        break;
      case "create_table":
        steps.push({
          itemId: item.id,
          phase: 1,
          label: `Create table ${p.table}`,
          sql: `CREATE TABLE ${q(p.table)} (\n  ${p.columns.map((c) => columnDdl(c, false)).join(",\n  ")}\n);`,
        });
        for (const c of p.columns) {
          if (c.references) {
            steps.push(
              fkStep(item.id, p.table, c.name, c.references.table, c.references.column, c.references.onDelete),
            );
          }
        }
        break;
      case "add_column": {
        // A NOT NULL column without a default is added nullable, filled by
        // backfills, then enforced, so existing rows never block the ALTER.
        const deferNotNull = !p.column.nullable && !p.column.default;
        steps.push({
          itemId: item.id,
          phase: 2,
          label: `Add column ${p.table}.${p.column.name}`,
          sql: `ALTER TABLE ${q(p.table)} ADD COLUMN ${columnDdl(p.column, deferNotNull)};`,
        });
        if (deferNotNull) steps.push(notNullStep(item.id, p.table, p.column.name));
        if (p.column.references) {
          steps.push(
            fkStep(
              item.id,
              p.table,
              p.column.name,
              p.column.references.table,
              p.column.references.column,
              p.column.references.onDelete,
            ),
          );
        }
        break;
      }
      case "backfill":
        steps.push({
          itemId: item.id,
          phase: 3,
          label: `Backfill ${p.table}${p.column ? `.${p.column}` : ""}`,
          sql: p.sql.trim().endsWith(";") ? p.sql.trim() : `${p.sql.trim()};`,
        });
        break;
      case "set_not_null":
        steps.push(notNullStep(item.id, p.table, p.column));
        break;
      case "add_unique": {
        const cols = p.columns.map((c) => (p.caseInsensitive ? `lower(${q(c)})` : q(c)));
        const name = `${p.table}_${p.columns.join("_")}_${p.caseInsensitive ? "lower_" : ""}key`.slice(0, 63);
        steps.push({
          itemId: item.id,
          phase: 5,
          label: `Unique ${p.table} (${p.columns.join(", ")})`,
          sql: `CREATE UNIQUE INDEX ${q(name)} ON ${q(p.table)} (${cols.join(", ")});`,
          check: {
            type: "unique",
            table: p.table,
            columns: p.columns,
            caseInsensitive: p.caseInsensitive,
          },
        });
        break;
      }
      case "add_foreign_key":
        steps.push(fkStep(item.id, p.table, p.column, p.refTable, p.refColumn, p.onDelete));
        break;
      case "add_index": {
        const name = `${p.table}_${p.columns.join("_")}_idx`.slice(0, 63);
        steps.push({
          itemId: item.id,
          phase: 7,
          label: `Index ${p.table} (${p.columns.join(", ")})`,
          sql: `CREATE INDEX ${q(name)} ON ${q(p.table)} (${p.columns.map(q).join(", ")});`,
        });
        break;
      }
    }
  }
  const backfillDepth = (step: MigrationStep) => {
    if (step.phase !== 3) return 0;
    const item = ordered.find((i) => i.id === step.itemId);
    return item && "table" in item.payload ? (depths.get(item.payload.table) ?? 0) : 0;
  };
  // Stable sort keeps item order inside a phase.
  return steps
    .map((step, index) => ({ step, index }))
    .sort(
      (a, b) =>
        a.step.phase - b.step.phase ||
        backfillDepth(a.step) - backfillDepth(b.step) ||
        a.index - b.index,
    )
    .map(({ step }) => step);
}

export function migrationSql(steps: MigrationStep[]): string {
  if (steps.length === 0) return "-- No changes yet.\n";
  return `BEGIN;\n\n${steps.map((s) => `-- ${s.label}\n${s.sql}`).join("\n\n")}\n\nCOMMIT;\n`;
}

// ---------------------------------------------------------------------------
// Relationship helpers used by drawing.

/**
 * Finds a join path from `from` to a table that already holds (or will hold)
 * a column pointing at `target`, following foreign keys. Used to backfill a
 * new foreign key from data the rows are already connected to.
 */
export function findBackfillPath(
  projected: ProjectedSchema,
  from: string,
  target: string,
): { hops: ProjectedEdge[]; sourceColumn: string } | null {
  const pointsAtTarget = (tableName: string) =>
    projected.edges.find(
      (e) => e.table === tableName && e.refTable === target && !e.dropped,
    );
  // Breadth-first, so the shortest chain of foreign keys wins.
  const queue: { table: string; hops: ProjectedEdge[] }[] = [{ table: from, hops: [] }];
  const seen = new Set([from, target]);
  while (queue.length) {
    const { table, hops } = queue.shift()!;
    if (hops.length > 0) {
      const edge = pointsAtTarget(table);
      if (edge) return { hops, sourceColumn: edge.column };
    }
    if (hops.length >= 3) continue;
    for (const edge of projected.edges) {
      if (edge.table !== table || edge.dropped || seen.has(edge.refTable)) continue;
      seen.add(edge.refTable);
      queue.push({ table: edge.refTable, hops: [...hops, edge] });
    }
  }
  return null;
}

export function backfillSqlForPath(
  from: string,
  column: string,
  path: { hops: ProjectedEdge[]; sourceColumn: string },
): string {
  const aliases = path.hops.map((_, index) => `t${index + 1}`);
  const last = aliases[aliases.length - 1];
  const fromList = path.hops.map((hop, index) => `${q(hop.refTable)} ${aliases[index]}`);
  const joins = path.hops.map((hop, index) => {
    const left = index === 0 ? "s" : aliases[index - 1];
    return `${left}.${q(hop.column)} = ${aliases[index]}.${q(hop.refColumn)}`;
  });
  return `UPDATE ${q(from)} s\nSET ${q(column)} = ${last}.${q(path.sourceColumn)}\nFROM ${fromList.join(", ")}\nWHERE ${joins.join("\n  AND ")};`;
}

export function primaryKeyColumn(table: TableInfo | ProjectedTable): string | null {
  if ("primaryKey" in table) return table.primaryKey[0] ?? null;
  return table.columns.find((c) => c.isPrimaryKey)?.name ?? null;
}

/**
 * The migration to ship: compiled steps with the chosen conflict fixes placed
 * before the step they unblock, and skipped steps left out.
 */
export function shippableMigrationSql(
  steps: MigrationStep[],
  rehearsal: { steps: { label: string; status: string; fixSql?: string[] | undefined; fixDetail?: string | undefined }[] } | null,
): string {
  if (steps.length === 0) return "-- No changes yet.\n";
  const parts = steps.flatMap((step, index) => {
    const ran = rehearsal?.steps[index];
    if (ran && ran.label === step.label && ran.status === "skipped") {
      return [`-- ${step.label}: skipped (conflict left in place)`];
    }
    const fix = ran && ran.label === step.label && ran.fixSql?.length
      ? [`-- Fix before "${step.label}": ${ran.fixDetail ?? "data fix"}\n${ran.fixSql.join("\n")}`]
      : [];
    return [...fix, `-- ${step.label}\n${step.sql}`];
  });
  return `BEGIN;\n\n${parts.join("\n\n")}\n\nCOMMIT;\n`;
}
