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

// Schemas the platform or tooling owns; every other schema belongs to the app.
const PLATFORM_SCHEMAS = [
  "pg_catalog", "information_schema", "pg_toast",
  "auth", "storage", "extensions", "realtime", "_realtime", "graphql", "graphql_public",
  "supabase_functions", "supabase_migrations", "vault", "pgsodium", "pgsodium_masks",
  "net", "cron", "pgbouncer", "_analytics", "drizzle", "tiger", "topology",
];
const APP_SCHEMA = `n.nspname NOT IN (${PLATFORM_SCHEMAS.map((s) => `'${s}'`).join(", ")}) AND n.nspname NOT LIKE 'pg\\_%'`;

/** Tables in public keep their bare name; others are "schema.table". */
const tableKey = (schema: string, table: string) => (schema === "public" ? table : `${schema}.${table}`);
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Reads the app's schemas (public plus any it creates) from Postgres catalogs. */
export async function introspect(pg: PGliteInterface): Promise<SchemaSnapshot> {
  const columns = await pg.query<{
    schema: string;
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
  }>(`
    SELECT n.nspname AS "schema", c.relname AS "table", a.attname AS "name",
           format_type(a.atttypid, a.atttypmod) AS "type",
           NOT a.attnotnull AS "nullable",
           pg_get_expr(d.adbin, d.adrelid) AS "default"
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE ${APP_SCHEMA} AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY n.nspname <> 'public', n.nspname, c.relname, a.attnum
  `);

  const constraints = await pg.query<{
    name: string;
    type: "p" | "u" | "f";
    schema: string;
    table: string;
    refTable: string | null;
    refSchema: string | null;
    columns: string[];
    refColumns: string[] | null;
    onDelete: string;
  }>(`
    SELECT con.conname AS "name", con.contype AS "type", n.nspname AS "schema", rel.relname AS "table",
           frel.relname AS "refTable",
           fn.nspname AS "refSchema",
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
    LEFT JOIN pg_namespace fn ON fn.oid = frel.relnamespace
    WHERE ${APP_SCHEMA} AND con.contype IN ('p', 'u', 'f')
    ORDER BY n.nspname, rel.relname, con.conname
  `);

  const indexes = await pg.query<{
    schema: string;
    table: string;
    name: string;
    definition: string;
    isUnique: boolean;
    isConstraint: boolean;
    columns: string[];
    expression: string | null;
  }>(`
    SELECT n.nspname AS "schema", t.relname AS "table", i.relname AS "name",
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
    WHERE ${APP_SCHEMA}
    ORDER BY n.nspname, t.relname, i.relname
  `);

  const key = (row: { schema: string; table: string }) => tableKey(row.schema, row.table);
  const known = new Map<string, { schema: string; table: string }>();
  for (const row of columns.rows) if (!known.has(key(row))) known.set(key(row), row);
  const tables: TableInfo[] = [];
  for (const [name, ref] of known) {
    const count = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${quoted(ref.schema)}.${quoted(ref.table)}`,
    );
    const own = constraints.rows.filter((row) => key(row) === name);
    const ownIndexes = indexes.rows.filter((row) => key(row) === name);
    tables.push({
      name,
      columns: columns.rows
        .filter((row) => key(row) === name)
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
      // References into platform schemas (Supabase's auth.users) are not on the map.
      foreignKeys: own
        .filter((row) => row.type === "f" && row.refTable && row.refSchema && known.has(tableKey(row.refSchema, row.refTable)))
        .map((row) => ({
          name: row.name,
          columns: row.columns,
          refTable: tableKey(row.refSchema!, row.refTable!),
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
