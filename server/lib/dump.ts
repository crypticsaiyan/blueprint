import type { PGliteInterface } from "@electric-sql/pglite";

import type { ForeignKeyInfo, SchemaSnapshot, TableInfo } from "../../shared/schema-types.js";
import { introspect } from "./introspect.js";
import { literal } from "./rehearse.js";

// Words that cannot appear as bare identifiers in Postgres DDL.
const RESERVED = new Set(
  "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with".split(
    " ",
  ),
);

/** An identifier the way pg_dump writes it: bare when it can be, quoted otherwise. */
export function ident(name: string) {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** Schema and bare name of a map table: "s.t" is in s, "t" is in public. */
export function splitTable(name: string): [schema: string, table: string] {
  const dot = name.indexOf(".");
  return dot < 0 ? ["public", name] : [name.slice(0, dot), name.slice(dot + 1)];
}

/** A table the way pg_dump references it: always schema-qualified. */
export function tableRef(name: string) {
  const [schema, table] = splitTable(name);
  return `${ident(schema)}.${ident(table)}`;
}

const NUMERIC = /^(smallint|integer|bigint|numeric|real|double precision|decimal)\b/;

/** A column value read back as text, written as a SQL literal. */
export function valueSql(value: string | null, type: string) {
  if (value === null) return "NULL";
  if (NUMERIC.test(type) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value)) return value;
  if (type === "boolean" && (value === "true" || value === "false")) return value;
  return literal(value);
}

export function columnSql(column: TableInfo["columns"][number]) {
  return `${ident(column.name)} ${column.type}${column.default ? ` DEFAULT ${column.default}` : ""}${column.nullable ? "" : " NOT NULL"}`;
}

/** Unique constraints, not unique indexes (those are written as indexes). */
export function uniqueConstraints(table: TableInfo) {
  const indexNames = new Set(table.indexes.map((i) => i.name));
  return table.uniques.filter((u) => !u.expression && !indexNames.has(u.name));
}

export function createTableSql(table: TableInfo) {
  const items = table.columns.map(columnSql);
  if (table.primaryKey.length) {
    items.push(`CONSTRAINT ${ident(`${splitTable(table.name)[1]}_pkey`)} PRIMARY KEY (${table.primaryKey.map(ident).join(", ")})`);
  }
  for (const unique of uniqueConstraints(table)) {
    items.push(`CONSTRAINT ${ident(unique.name)} UNIQUE (${unique.columns.map(ident).join(", ")})`);
  }
  return `CREATE TABLE ${tableRef(table.name)} (\n${items.map((i) => `    ${i}`).join(",\n")}\n);`;
}

export function foreignKeySql(table: string, fk: ForeignKeyInfo) {
  const onDelete = fk.onDelete === "no action" ? "" : ` ON DELETE ${fk.onDelete.toUpperCase()}`;
  return `ALTER TABLE ONLY ${tableRef(table)} ADD CONSTRAINT ${ident(fk.name)} FOREIGN KEY (${fk.columns.map(ident).join(", ")}) REFERENCES ${tableRef(fk.refTable)}(${fk.refColumns.map(ident).join(", ")})${onDelete};`;
}

export function uniqueSql(table: string, unique: TableInfo["uniques"][number]) {
  return `ALTER TABLE ONLY ${tableRef(table)} ADD CONSTRAINT ${ident(unique.name)} UNIQUE (${unique.columns.map(ident).join(", ")});`;
}

export type TextRow = Record<string, string | null>;

/** Every row as text, in primary key order (or full-row order without one). */
export async function readRows(pg: PGliteInterface, table: TableInfo): Promise<TextRow[]> {
  const select = table.columns.map((c) => `${ident(c.name)}::text AS ${ident(c.name)}`).join(", ");
  // Without a key, sort by the text values: types such as json have no ordering.
  const order = table.primaryKey.length
    ? ` ORDER BY ${table.primaryKey.map(ident).join(", ")}`
    : table.columns.length
      ? ` ORDER BY ${table.columns.map((_, i) => i + 1).join(", ")}`
      : "";
  const result = await pg.query<TextRow>(`SELECT ${select} FROM ${tableRef(table.name)}${order}`);
  return result.rows;
}

export function insertSql(table: TableInfo, row: TextRow, ref = tableRef(table.name)) {
  const names = table.columns.map((c) => ident(c.name)).join(", ");
  const values = table.columns.map((c) => valueSql(row[c.name] ?? null, c.type));
  return `INSERT INTO ${ref} (${names}) VALUES (${values.join(", ")});`;
}

export function parentsFirst(snapshot: SchemaSnapshot): TableInfo[] {
  const done = new Set<string>();
  const out: TableInfo[] = [];
  const visit = (table: TableInfo, trail: Set<string>) => {
    if (done.has(table.name) || trail.has(table.name)) return;
    trail.add(table.name);
    for (const fk of table.foreignKeys) {
      const parent = snapshot.tables.find((t) => t.name === fk.refTable);
      if (parent && parent !== table) visit(parent, trail);
    }
    done.add(table.name);
    out.push(table);
  };
  [...snapshot.tables].sort((a, b) => a.name.localeCompare(b.name)).forEach((t) => visit(t, new Set()));
  return out;
}

/**
 * Writes a plain SQL dump (tables, data, then constraints and indexes) in the
 * same shape as pg_dump --inserts, so a repo's test fixtures can load it.
 */
export async function dumpDatabase(pg: PGliteInterface, title: string): Promise<string> {
  const snapshot = await introspect(pg);
  const tables = parentsFirst(snapshot);
  const out: string[] = [`--\n-- ${title}\n--\n`];
  const schemas = [...new Set(tables.map((t) => splitTable(t.name)[0]))].filter((s) => s !== "public");
  for (const schema of schemas) out.push(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)};\n`);
  for (const table of tables) out.push(`${createTableSql(table)}\n`);
  out.push("--\n-- Data\n--\n");
  for (const table of tables) {
    const rows = await readRows(pg, table);
    for (const row of rows) out.push(insertSql(table, row));
    if (rows.length) out.push("");
  }
  out.push("--\n-- Constraints and indexes\n--\n");
  for (const table of tables) {
    for (const fk of table.foreignKeys) out.push(foreignKeySql(table.name, fk));
    for (const index of table.indexes) out.push(`${index.definition};`);
  }
  return `${out.join("\n")}\n`;
}
