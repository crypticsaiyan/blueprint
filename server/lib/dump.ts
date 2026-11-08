import type { PGliteInterface } from "@electric-sql/pglite";

import { q } from "../../shared/changes.js";
import type { SchemaSnapshot, TableInfo } from "../../shared/schema-types.js";
import { introspect } from "./introspect.js";
import { literal } from "./rehearse.js";

function parentsFirst(snapshot: SchemaSnapshot): TableInfo[] {
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
  for (const table of tables) {
    const cols = table.columns.map(
      (c) => `    ${q(c.name)} ${c.type}${c.default ? ` DEFAULT ${c.default}` : ""}${c.nullable ? "" : " NOT NULL"}`,
    );
    if (table.primaryKey.length) {
      cols.push(`    CONSTRAINT ${q(`${table.name}_pkey`)} PRIMARY KEY (${table.primaryKey.map(q).join(", ")})`);
    }
    for (const unique of table.uniques.filter((u) => !u.expression)) {
      cols.push(`    CONSTRAINT ${q(unique.name)} UNIQUE (${unique.columns.map(q).join(", ")})`);
    }
    out.push(`CREATE TABLE public.${q(table.name)} (\n${cols.join(",\n")}\n);\n`);
  }
  out.push("--\n-- Data\n--\n");
  for (const table of tables) {
    const order = table.primaryKey.length ? ` ORDER BY ${table.primaryKey.map(q).join(", ")}` : "";
    const select = table.columns.map((c) => `${q(c.name)}::text AS ${q(c.name)}`).join(", ");
    const rows = await pg.query<Record<string, string | null>>(`SELECT ${select} FROM ${q(table.name)}${order}`);
    const names = table.columns.map((c) => q(c.name)).join(", ");
    for (const row of rows.rows) {
      const values = table.columns.map((c) => (row[c.name] === null ? "NULL" : literal(row[c.name]!)));
      out.push(`INSERT INTO public.${q(table.name)} (${names}) VALUES (${values.join(", ")});`);
    }
    if (rows.rows.length) out.push("");
  }
  out.push("--\n-- Constraints and indexes\n--\n");
  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      const onDelete = fk.onDelete === "no action" ? "" : ` ON DELETE ${fk.onDelete.toUpperCase()}`;
      out.push(
        `ALTER TABLE public.${q(table.name)} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(", ")}) REFERENCES public.${q(fk.refTable)} (${fk.refColumns.map(q).join(", ")})${onDelete};`,
      );
    }
    for (const index of table.indexes) out.push(`${index.definition};`);
  }
  return `${out.join("\n")}\n`;
}
