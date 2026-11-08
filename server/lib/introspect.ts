import type { PGliteInterface } from "@electric-sql/pglite";

import type {
  ColumnInfo,
  SchemaSnapshot,
  TableInfo,
} from "../../shared/schema-types.js";

const ON_DELETE: Record<string, string> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

/** Reads the public schema from Postgres catalogs. */
export async function introspect(pg: PGliteInterface): Promise<SchemaSnapshot> {
  const columns = await pg.query<{
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
  }>(`
    SELECT c.relname AS "table", a.attname AS "name",
           format_type(a.atttypid, a.atttypmod) AS "type",
           NOT a.attnotnull AS "nullable",
           pg_get_expr(d.adbin, d.adrelid) AS "default"
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  `);

  const constraints = await pg.query<{
    name: string;
    type: "p" | "u" | "f";
    table: string;
    refTable: string | null;
    columns: string[];
    refColumns: string[] | null;
    onDelete: string;
  }>(`
    SELECT con.conname AS "name", con.contype AS "type", rel.relname AS "table",
           frel.relname AS "refTable",
           ARRAY(SELECT att.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
                 ORDER BY k.ord) AS "columns",
           ARRAY(SELECT att.attname FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.attnum
                 ORDER BY k.ord) AS "refColumns",
           con.confdeltype AS "onDelete"
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    LEFT JOIN pg_class frel ON frel.oid = con.confrelid
    WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'f')
    ORDER BY rel.relname, con.conname
  `);

  const indexes = await pg.query<{
    table: string;
    name: string;
    definition: string;
    isUnique: boolean;
    isConstraint: boolean;
    columns: string[];
    expression: string | null;
  }>(`
    SELECT t.relname AS "table", i.relname AS "name",
           pg_get_indexdef(ix.indexrelid) AS "definition",
           ix.indisunique AS "isUnique",
           EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid) AS "isConstraint",
           ARRAY(SELECT a.attname FROM unnest(ix.indkey) k(attnum)
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS "columns",
           pg_get_expr(ix.indexprs, ix.indrelid) AS "expression"
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.relname, i.relname
  `);

  const tableNames = [...new Set(columns.rows.map((row) => row.table))];
  const tables: TableInfo[] = [];
  for (const name of tableNames) {
    const count = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${name.replace(/"/g, '""')}"`,
    );
    const own = constraints.rows.filter((row) => row.table === name);
    const ownIndexes = indexes.rows.filter((row) => row.table === name);
    tables.push({
      name,
      columns: columns.rows
        .filter((row) => row.table === name)
        .map(
          (row): ColumnInfo => ({
            name: row.name,
            type: row.type,
            nullable: row.nullable,
            default: row.default,
          }),
        ),
      primaryKey: own.find((row) => row.type === "p")?.columns ?? [],
      uniques: [
        ...own
          .filter((row) => row.type === "u")
          .map((row) => ({ name: row.name, columns: row.columns, expression: null })),
        ...ownIndexes
          .filter((row) => row.isUnique && !row.isConstraint)
          .map((row) => ({
            name: row.name,
            columns: row.columns,
            expression: row.expression,
          })),
      ],
      foreignKeys: own
        .filter((row) => row.type === "f" && row.refTable)
        .map((row) => ({
          name: row.name,
          columns: row.columns,
          refTable: row.refTable!,
          refColumns: row.refColumns ?? [],
          onDelete: ON_DELETE[row.onDelete] ?? "no action",
        })),
      indexes: ownIndexes
        .filter((row) => !row.isConstraint)
        .map((row) => ({ name: row.name, definition: row.definition })),
      rowCount: count.rows[0]?.n ?? 0,
    });
  }
  return { tables };
}
