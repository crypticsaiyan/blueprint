// The database as Blueprint sees it: read from Postgres catalogs, never from
// ORM files, so it works for any Postgres app.

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string;
}

export interface UniqueInfo {
  name: string;
  columns: string[];
  /** Set for expression indexes such as `lower(email)`. */
  expression: string | null;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  uniques: UniqueInfo[];
  foreignKeys: ForeignKeyInfo[];
  indexes: { name: string; definition: string }[];
  rowCount: number;
}

export interface SchemaSnapshot {
  tables: TableInfo[];
}

export function findTable(
  snapshot: SchemaSnapshot,
  name: string,
): TableInfo | undefined {
  return snapshot.tables.find((table) => table.name === name);
}
