import type { PGliteInterface } from "@electric-sql/pglite";

import {
  compileMigration,
  q,
  qt,
  type ChangeItem,
  type MigrationStep,
  type StepCheck,
} from "../../shared/changes.js";
import type {
  ConflictKind,
  ConflictReport,
  FixOption,
  RehearsalResult,
  Resolution,
  RowDiff,
  StepResult,
  TableDiff,
} from "../../shared/rehearsal-types.js";
import type { SchemaSnapshot, TableInfo } from "../../shared/schema-types.js";
import { introspect } from "./introspect.js";

const ROW_CAPTURE_LIMIT = 500;
const SAMPLE_LIMIT = 8;

type Row = Record<string, unknown>;
type Queryable = Pick<PGliteInterface, "query" | "exec">;

interface Reference {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

export function conflictKey(itemId: string, kind: ConflictKind) {
  return `${itemId}:${kind}`;
}

/** Foreign keys the plan will add; they count as references for fixes. */
function plannedReferences(items: ChangeItem[]): Reference[] {
  const refs: Reference[] = [];
  for (const item of items) {
    if (item.status === "rejected") continue;
    const p = item.payload;
    if (p.kind === "add_foreign_key") {
      refs.push({ table: p.table, column: p.column, refTable: p.refTable, refColumn: p.refColumn });
    } else if (p.kind === "add_column" && p.column.references) {
      refs.push({
        table: p.table,
        column: p.column.name,
        refTable: p.column.references.table,
        refColumn: p.column.references.column,
      });
    } else if (p.kind === "create_table") {
      for (const c of p.columns) {
        if (c.references) {
          refs.push({ table: p.table, column: c.name, refTable: c.references.table, refColumn: c.references.column });
        }
      }
    }
  }
  return refs;
}

function liveReferences(snapshot: SchemaSnapshot): Reference[] {
  return snapshot.tables.flatMap((table) =>
    table.foreignKeys
      .filter((fk) => fk.columns.length === 1)
      .map((fk) => ({
        table: table.name,
        column: fk.columns[0]!,
        refTable: fk.refTable,
        refColumn: fk.refColumns[0]!,
      })),
  );
}

function referencesTo(table: string, live: SchemaSnapshot, planned: Reference[]): Reference[] {
  const seen = new Set<string>();
  const exists = (r: Reference) =>
    live.tables.some((t) => t.name === r.table && t.columns.some((c) => c.name === r.column));
  return [...liveReferences(live), ...planned]
    .filter((r) => r.refTable === table && exists(r))
    .filter((r) => {
      const key = `${r.table}.${r.column}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function orderClause(table: TableInfo | undefined) {
  if (!table) return "1";
  const hasCreated = table.columns.some((c) => c.name === "created_at");
  const pk = table.primaryKey.map(q).join(", ") || "ctid";
  return hasCreated ? `"created_at", ${pk}` : pk;
}

function rowKey(table: TableInfo | undefined, row: Row): string | null {
  if (!table || table.primaryKey.length === 0) return null;
  return table.primaryKey.map((c) => String(row[c])).join("|");
}

function uniqueParts(check: Extract<StepCheck, { type: "unique" }>) {
  return check.columns.map((c) => (check.caseInsensitive ? `lower(${q(c)}::text)` : q(c)));
}

/** The key as one value: a column, or a row (a, b) to compare against a subquery. */
function uniqueExpr(check: Extract<StepCheck, { type: "unique" }>) {
  const parts = uniqueParts(check);
  return parts.length === 1 ? parts[0]! : `(${parts.join(", ")})`;
}

/** The key as a column list, for SELECT, GROUP BY and PARTITION BY. */
function uniqueList(check: Extract<StepCheck, { type: "unique" }>) {
  return uniqueParts(check).join(", ");
}

function conflictWhere(check: StepCheck): string {
  switch (check.type) {
    case "not_null":
      return `${q(check.column)} IS NULL`;
    case "foreign_key":
      return `${q(check.column)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${qt(check.refTable)} p WHERE p.${q(check.refColumn)} = ${qt(check.table)}.${q(check.column)})`;
    case "unique": {
      const expr = uniqueExpr(check);
      const notNull = check.columns.map((c) => `${q(c)} IS NOT NULL`).join(" AND ");
      const list = uniqueList(check);
      return `${notNull} AND ${expr} IN (SELECT ${list} FROM ${qt(check.table)} GROUP BY ${list} HAVING count(*) > 1)`;
    }
  }
}

function kindFor(check: StepCheck): ConflictKind {
  return check.type === "not_null" ? "null_values" : check.type === "unique" ? "duplicates" : "orphans";
}

function fixOptions(check: StepCheck, live: SchemaSnapshot): FixOption[] {
  switch (check.type) {
    case "not_null":
      return [
        { id: "fill_value", label: "Fill with a value", description: `Set ${check.column} on these rows to a value you choose.`, needsValue: true },
        { id: "delete_rows", label: "Delete these rows", description: "Delete the rows, and rows that depend on them." },
        { id: "skip", label: "Keep it nullable", description: "Skip the NOT NULL constraint for now." },
      ];
    case "unique":
      return [
        { id: "merge_duplicates", label: "Merge into the oldest", description: "Keep the oldest row in each group, move references to it, delete the rest." },
        { id: "rename_duplicates", label: "Rename duplicates", description: "Make later duplicates distinct (name+dup1@domain for emails)." },
        { id: "skip", label: "Skip the constraint", description: "Leave duplicates and do not add the unique index." },
      ];
    case "foreign_key": {
      const column = live.tables
        .find((t) => t.name === check.table)
        ?.columns.find((c) => c.name === check.column);
      const options: FixOption[] = [];
      if (column?.nullable) {
        options.push({ id: "set_null", label: "Clear the reference", description: `Set ${check.column} to NULL on orphaned rows.` });
      }
      options.push(
        { id: "delete_rows", label: "Delete orphaned rows", description: "Delete the orphaned rows, and rows that depend on them." },
        { id: "skip", label: "Skip the foreign key", description: "Leave orphans and do not add the constraint." },
      );
      return options;
    }
  }
}

async function detectConflict(
  pg: Queryable,
  step: MigrationStep,
  check: StepCheck,
  live: SchemaSnapshot,
): Promise<ConflictReport | null> {
  const table = live.tables.find((t) => t.name === check.table);
  if (!table) return null;
  if (check.type === "foreign_key" && !live.tables.some((t) => t.name === check.refTable)) return null;
  const where = conflictWhere(check);
  const count = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${qt(check.table)} WHERE ${where}`,
  );
  const rowCount = count.rows[0]?.n ?? 0;
  if (rowCount === 0) return null;
  const sample = await pg.query<Row>(
    `SELECT * FROM ${qt(check.table)} WHERE ${where} ORDER BY ${check.type === "unique" ? `${uniqueList(check)}, ` : ""}${orderClause(table)} LIMIT 50`,
  );
  const kind = kindFor(check);
  let groups: number | undefined;
  if (check.type === "unique") {
    const g = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${qt(check.table)} WHERE ${where} GROUP BY ${uniqueList(check)}) g`,
    );
    groups = g.rows[0]?.n ?? 0;
  }
  const plural = rowCount === 1 ? "" : "s";
  const message =
    check.type === "not_null"
      ? `${rowCount} ${check.table} row${plural} have no ${check.column}; NOT NULL would fail.`
      : check.type === "unique"
        ? `${rowCount} ${check.table} rows share ${groups} duplicated value${groups === 1 ? "" : "s"} of ${check.columns.join(", ")}; the unique index would fail.`
        : `${rowCount} ${check.table} row${plural} point at ${check.refTable} rows that do not exist; the foreign key would fail.`;
  return {
    key: conflictKey(step.itemId, kind),
    itemId: step.itemId,
    kind,
    table: check.table,
    columns: check.type === "unique" ? check.columns : [check.column],
    rowCount,
    groups,
    message,
    sampleColumns: table.columns.map((c) => c.name),
    sampleRows: sample.rows.slice(0, SAMPLE_LIMIT),
    rowKeys: sample.rows.map((row) => rowKey(table, row)).filter((k): k is string => k !== null),
    fixes: fixOptions(check, live),
    stepLabel: step.label,
  };
}

/** Runs fix SQL and keeps the exact statements, so the shipped migration can replay them. */
class FixRecorder {
  statements: string[] = [];
  constructor(private pg: Queryable) {}
  async run(sql: string) {
    this.statements.push(sql.replace(/\s+\n/g, "\n").trim() + ";");
    return this.pg.query(sql);
  }
}

export const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Deletes matching rows and, first, the rows that reference them. */
async function deleteCascading(
  rec: FixRecorder,
  table: string,
  where: string,
  live: SchemaSnapshot,
  planned: Reference[],
  counts: Record<string, number>,
  depth = 0,
) {
  if (depth > 4) throw new Error(`Dependency chain under ${table} is too deep to delete safely.`);
  for (const ref of referencesTo(table, live, planned)) {
    if (ref.table === table) continue;
    await deleteCascading(
      rec,
      ref.table,
      `${q(ref.column)} IN (SELECT ${q(ref.refColumn)} FROM ${qt(table)} WHERE ${where})`,
      live,
      planned,
      counts,
      depth + 1,
    );
  }
  const result = await rec.run(`DELETE FROM ${qt(table)} WHERE ${where}`);
  counts[table] = (counts[table] ?? 0) + (result.affectedRows ?? 0);
}

function describeCounts(verb: string, counts: Record<string, number>) {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${n} ${t}`);
  return parts.length ? `${verb} ${parts.join(", ")}` : `${verb} nothing`;
}

async function applyFix(
  pg: Queryable,
  check: StepCheck,
  resolution: Resolution,
  live: SchemaSnapshot,
  planned: Reference[],
): Promise<{ rowsAffected: number; detail: string; sql: string[] }> {
  const rec = new FixRecorder(pg);
  const table = live.tables.find((t) => t.name === check.table);
  const where = conflictWhere(check);
  const done = (rowsAffected: number, detail: string) => ({ rowsAffected, detail, sql: rec.statements });
  switch (resolution.fix) {
    case "fill_value": {
      if (check.type !== "not_null") break;
      if (resolution.value === undefined || resolution.value === "") {
        throw new Error("This fix needs a value.");
      }
      const result = await rec.run(
        `UPDATE ${qt(check.table)} SET ${q(check.column)} = ${literal(resolution.value)} WHERE ${where}`,
      );
      return done(result.affectedRows ?? 0, `Filled ${result.affectedRows ?? 0} ${check.table}.${check.column} with ${JSON.stringify(resolution.value)}`);
    }
    case "delete_rows": {
      const counts: Record<string, number> = {};
      await deleteCascading(rec, check.table, where, live, planned, counts);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return done(total, describeCounts("Deleted", counts));
    }
    case "set_null": {
      if (check.type !== "foreign_key") break;
      const result = await rec.run(`UPDATE ${qt(check.table)} SET ${q(check.column)} = NULL WHERE ${where}`);
      return done(result.affectedRows ?? 0, `Cleared ${result.affectedRows ?? 0} ${check.table}.${check.column}`);
    }
    case "merge_duplicates": {
      if (check.type !== "unique" || !table || table.primaryKey.length !== 1) {
        throw new Error("Merging needs a single-column primary key.");
      }
      const pk = q(table.primaryKey[0]!);
      // Set-based so the same statements run unchanged against production.
      await rec.run(
        `CREATE TEMP TABLE blueprint_merge AS
         SELECT ${pk} AS dupe, first_value(${pk}) OVER (PARTITION BY ${uniqueList(check)} ORDER BY ${orderClause(table)}) AS keep
         FROM ${qt(check.table)} WHERE ${where}`,
      );
      await rec.run(`DELETE FROM blueprint_merge WHERE dupe = keep`);
      const counts: Record<string, number> = {};
      for (const ref of referencesTo(check.table, live, planned)) {
        const moved = await rec.run(
          `UPDATE ${qt(ref.table)} r SET ${q(ref.column)} = m.keep FROM blueprint_merge m WHERE r.${q(ref.column)} = m.dupe`,
        );
        counts[ref.table] = (counts[ref.table] ?? 0) + (moved.affectedRows ?? 0);
      }
      const keepers = await pg.query<{ n: number }>(`SELECT count(DISTINCT keep)::int AS n FROM blueprint_merge`);
      const deleted = await rec.run(`DELETE FROM ${qt(check.table)} t USING blueprint_merge m WHERE t.${pk} = m.dupe`);
      await rec.run(`DROP TABLE blueprint_merge`);
      const removed = deleted.affectedRows ?? 0;
      return done(removed, `Merged ${removed} duplicate ${check.table} into ${keepers.rows[0]?.n ?? 0}; ${describeCounts("repointed", counts)}`);
    }
    case "rename_duplicates": {
      if (check.type !== "unique" || !table || table.primaryKey.length === 0) {
        throw new Error("Renaming needs a primary key.");
      }
      const col = q(check.columns[0]!);
      const pkMatch = table.primaryKey.map((c) => `t.${q(c)} = d.${q(c)}`).join(" AND ");
      const result = await rec.run(
        `UPDATE ${qt(check.table)} t
         SET ${col} = CASE WHEN t.${col}::text LIKE '%@%'
           THEN split_part(t.${col}::text, '@', 1) || '+dup' || (d.rn - 1) || '@' || split_part(t.${col}::text, '@', 2)
           ELSE t.${col}::text || '-' || d.rn END
         FROM (SELECT ${table.primaryKey.map(q).join(", ")},
                      row_number() OVER (PARTITION BY ${uniqueList(check)} ORDER BY ${orderClause(table)}) AS rn
               FROM ${qt(check.table)} WHERE ${where}) d
         WHERE ${pkMatch} AND d.rn > 1`,
      );
      return done(result.affectedRows ?? 0, `Renamed ${result.affectedRows ?? 0} duplicate ${check.table}.${check.columns[0]}`);
    }
  }
  throw new Error(`Fix "${resolution.fix}" does not apply to this conflict.`);
}

async function captureRows(pg: Queryable, snapshot: SchemaSnapshot) {
  const out = new Map<string, Map<string, Row>>();
  for (const table of snapshot.tables) {
    if (table.primaryKey.length === 0) continue;
    const result = await pg.query<Row>(
      `SELECT * FROM ${qt(table.name)} ORDER BY ${table.primaryKey.map(q).join(", ")} LIMIT ${ROW_CAPTURE_LIMIT}`,
    );
    const rows = new Map<string, Row>();
    for (const row of result.rows) rows.set(rowKey(table, row)!, row);
    out.set(table.name, rows);
  }
  return out;
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffTables(
  before: SchemaSnapshot,
  after: SchemaSnapshot,
  beforeRows: Map<string, Map<string, Row>>,
  afterRows: Map<string, Map<string, Row>>,
  highlight: Map<string, Set<string>>,
): TableDiff[] {
  const diffs: TableDiff[] = [];
  for (const table of after.tables) {
    const prev = before.tables.find((t) => t.name === table.name);
    const columns = table.columns.map((c) => c.name);
    const newColumns = prev
      ? columns.filter((c) => !prev.columns.some((p) => p.name === c))
      : columns;
    const b = beforeRows.get(table.name) ?? new Map<string, Row>();
    const a = afterRows.get(table.name) ?? new Map<string, Row>();
    const rows: RowDiff[] = [];
    const counts = { same: 0, changed: 0, added: 0, deleted: 0 };
    for (const [key, row] of a) {
      const old = b.get(key);
      if (!old) {
        counts.added++;
        rows.push({ key, status: "added", before: null, after: row, changed: columns });
        continue;
      }
      const changed = columns.filter((c) => !same(old[c], row[c]));
      if (changed.length) {
        counts.changed++;
        rows.push({ key, status: "changed", before: old, after: row, changed });
      } else {
        counts.same++;
        rows.push({ key, status: "same", before: old, after: row, changed: [] });
      }
    }
    for (const [key, row] of b) {
      if (!a.has(key)) {
        counts.deleted++;
        rows.push({ key, status: "deleted", before: row, after: null, changed: [] });
      }
    }
    const touched = counts.changed + counts.added + counts.deleted > 0 || newColumns.length > 0;
    const marked = highlight.get(table.name);
    if (!touched && !marked) continue;
    const interesting = rows.filter((r) => r.status !== "same" || marked?.has(r.key));
    const context = rows.filter((r) => r.status === "same" && !marked?.has(r.key)).slice(0, 4);
    diffs.push({
      table: table.name,
      isNew: !prev,
      columns,
      newColumns,
      primaryKey: table.primaryKey,
      counts,
      rowCountBefore: prev?.rowCount ?? 0,
      rowCountAfter: table.rowCount,
      rows: [...interesting.slice(0, 120), ...context].sort((x, y) => x.key.localeCompare(y.key)),
    });
  }
  return diffs;
}

export async function rehearse(options: {
  pg: PGliteInterface;
  items: ChangeItem[];
  snapshot: SchemaSnapshot;
  resolutions: Resolution[];
  measure?: { table: string; column: string };
}): Promise<RehearsalResult> {
  const { pg, items } = options;
  const started = Date.now();
  const steps = compileMigration(items, options.snapshot);
  const planned = plannedReferences(items);
  const resolutions = new Map(options.resolutions.map((r) => [r.key, r]));
  const before = await introspect(pg);
  const beforeRows = await captureRows(pg, before);

  const results: StepResult[] = [];
  const conflicts: ConflictReport[] = [];
  const highlight = new Map<string, Set<string>>();

  for (const [index, step] of steps.entries()) {
    const t0 = Date.now();
    const base = { index, itemId: step.itemId, label: step.label, sql: step.sql, phase: step.phase };
    let fixDetail: string | undefined;
    let fixSql: string[] | undefined;
    if (step.check) {
      const live = await introspect(pg);
      const conflict = await detectConflict(pg, step, step.check, live);
      if (conflict) {
        const marks = highlight.get(conflict.table) ?? new Set<string>();
        conflict.rowKeys.forEach((k) => marks.add(k));
        highlight.set(conflict.table, marks);
        const resolution = resolutions.get(conflict.key);
        conflict.resolution = resolution ?? null;
        conflicts.push(conflict);
        if (!resolution) {
          results.push({ ...base, status: "conflict", conflictKey: conflict.key, durationMs: Date.now() - t0 });
          continue;
        }
        if (resolution.fix === "skip") {
          results.push({ ...base, status: "skipped", conflictKey: conflict.key, durationMs: Date.now() - t0 });
          continue;
        }
        try {
          const fixed = await pg.transaction(async (tx) =>
            applyFix(tx, step.check!, resolution, live, planned),
          );
          fixDetail = fixed.detail;
          fixSql = fixed.sql;
          conflict.fixResult = fixed.detail;
        } catch (error) {
          results.push({
            ...base,
            status: "error",
            conflictKey: conflict.key,
            error: `Fix failed: ${(error as Error).message}`,
            durationMs: Date.now() - t0,
          });
          continue;
        }
      }
    }
    try {
      const affected = await pg.transaction(async (tx) => {
        const out = await tx.exec(step.sql);
        // PGlite reports affectedRows cumulatively across one exec() call.
        return out.reduce((max, r) => Math.max(max, r.affectedRows ?? 0), 0);
      });
      results.push({
        ...base,
        status: fixDetail ? "fixed" : "ok",
        rowsAffected: affected,
        fixDetail,
        fixSql,
        conflictKey: fixDetail ? conflicts[conflicts.length - 1]?.key : undefined,
        durationMs: Date.now() - t0,
      });
    } catch (error) {
      results.push({ ...base, status: "error", error: (error as Error).message, fixDetail, durationMs: Date.now() - t0 });
    }
  }

  const after = await introspect(pg);
  const afterRows = await captureRows(pg, after);
  let measured: RehearsalResult["measured"];
  if (options.measure) {
    const { table, column } = options.measure;
    const exists = after.tables
      .find((t) => t.name === table)
      ?.columns.some((c) => c.name === column);
    if (exists) {
      const m = await pg.query<{ total: number; filled: number }>(
        `SELECT count(*)::int AS total, count(${q(column)})::int AS filled FROM ${qt(table)}`,
      );
      const row = m.rows[0] ?? { total: 0, filled: 0 };
      measured = { table, column, total: row.total, filled: row.filled, empty: row.total - row.filled };
    }
  }

  const hasError = results.some((r) => r.status === "error");
  const open = results.some((r) => r.status === "conflict");
  return {
    status: hasError ? "failed" : open ? "conflicts" : "passed",
    steps: results,
    conflicts,
    tables: diffTables(before, after, beforeRows, afterRows, highlight),
    schemaAfter: after,
    durationMs: Date.now() - started,
    ...(measured ? { measured } : {}),
  };
}
