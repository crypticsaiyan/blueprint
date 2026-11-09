import type { PGlite, PGliteInterface } from "@electric-sql/pglite";

import type { SchemaSnapshot, TableInfo } from "../../shared/schema-types.js";
import {
  columnSql,
  createTableSql,
  foreignKeySql,
  ident,
  tableRef,
  insertSql,
  parentsFirst,
  readRows,
  uniqueConstraints,
  uniqueSql,
  valueSql,
  type TextRow,
} from "./dump.js";
import { introspect } from "./introspect.js";
import { skipQuoted, splitStatements, type Statement } from "./sql-statements.js";
import { loadSql } from "./sandbox.js";

// Rewrites the repo's own dump so it matches the migrated database while
// touching only what changed: untouched tables and rows keep their original
// text, so the pull request diff shows the migration and nothing else.

export { splitStatements };

const ID = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const REF = String.raw`(?:(${ID})\s*\.\s*)?(${ID})`;
const CREATE_RE = new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${REF}\s*\(`, "i");
const INSERT_RE = new RegExp(String.raw`^INSERT\s+INTO\s+${REF}`, "i");
const ALTER_RE = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:ONLY\s+)?${REF}\s+ADD\s+CONSTRAINT\s+(${ID})`, "i");
const INDEX_RE = new RegExp(
  String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${ID})\s+ON\s+(?:ONLY\s+)?${REF}`,
  "i",
);

function unquote(id: string) {
  return id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id.toLowerCase();
}

/** The map's name for a table reference: bare in public, "schema.table" elsewhere. */
function tableName(schemaPart: string | undefined, name: string | undefined) {
  if (!name) return null;
  const schema = schemaPart ? unquote(schemaPart) : "public";
  return schema === "public" ? unquote(name) : `${schema}.${unquote(name)}`;
}

/** Index just past a comment starting at `i`, or -1 when none starts there. */
function skipComment(s: string, i: number): number {
  if (s.startsWith("--", i)) {
    const end = s.indexOf("\n", i);
    return end < 0 ? s.length : end + 1;
  }
  if (s.startsWith("/*", i)) {
    const end = s.indexOf("*/", i + 2);
    return end < 0 ? s.length : end + 2;
  }
  return -1;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const comment = skipComment(s, i);
    if (comment >= 0) {
      i = comment;
      continue;
    }
    const quoted = skipQuoted(s, i);
    if (quoted >= 0) {
      i = quoted;
      continue;
    }
    if (s[i] === "(") depth += 1;
    else if (s[i] === ")" && --depth === 0) return i;
    i += 1;
  }
  return -1;
}

/** Splits on commas outside quotes, comments and parentheses. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const comment = skipComment(s, i);
    if (comment >= 0) {
      i = comment;
      continue;
    }
    const quoted = skipQuoted(s, i);
    if (quoted >= 0) {
      i = quoted;
      continue;
    }
    if (s[i] === "(") depth += 1;
    else if (s[i] === ")") depth -= 1;
    else if (s[i] === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(s.slice(start));
  return parts;
}

type Kind =
  | { type: "create"; table: string }
  | { type: "insert"; table: string }
  | { type: "constraint" | "index"; table: string; name: string }
  | { type: "other" };

function classify(body: string): Kind {
  let m = CREATE_RE.exec(body);
  if (m) {
    const table = tableName(m[1], m[2]);
    return table ? { type: "create", table } : { type: "other" };
  }
  m = INSERT_RE.exec(body);
  if (m) {
    const table = tableName(m[1], m[2]);
    return table ? { type: "insert", table } : { type: "other" };
  }
  m = ALTER_RE.exec(body);
  if (m) {
    const table = tableName(m[1], m[2]);
    return table ? { type: "constraint", table, name: unquote(m[3]!) } : { type: "other" };
  }
  m = INDEX_RE.exec(body);
  if (m) {
    const table = tableName(m[2], m[3]);
    return table ? { type: "index", table, name: unquote(m[1]!) } : { type: "other" };
  }
  return { type: "other" };
}

/**
 * True when writing a fresh dump in place of this file loses nothing: it is a
 * data dump made only of what Blueprint's own dump reproduces (tables, rows,
 * constraints, indexes, session settings). A hand-written schema with
 * policies, functions or triggers is not, and is left as it is.
 */
export function canRegenerate(original: string): boolean {
  const { statements } = splitStatements(original);
  if (!statements.some((s) => classify(s.body).type === "insert")) return false;
  return statements.every(
    (s) =>
      classify(s.body).type !== "other" ||
      /^(SET\s|SELECT\s+pg_catalog\.set_config\(|BEGIN\b|COMMIT\b)/i.test(s.body.trim()),
  );
}

interface ParsedInsert {
  /** The table reference as written, such as `public.users`. */
  ref: string;
  /** Column tokens as written; null when the statement lists none. */
  rawColumns: string[] | null;
  tuples: string[][];
}

function parseInsert(body: string): ParsedInsert | null {
  const m = INSERT_RE.exec(body);
  if (!m) return null;
  const ref = m[0].replace(/^INSERT\s+INTO\s+/i, "");
  let i = m[0].length;
  const skipSpace = () => {
    while (/\s/.test(body[i] ?? "")) i += 1;
  };
  skipSpace();
  let rawColumns: string[] | null = null;
  if (body[i] === "(") {
    const close = matchParen(body, i);
    if (close < 0) return null;
    rawColumns = splitTop(body.slice(i + 1, close)).map((c) => c.trim());
    i = close + 1;
    skipSpace();
  }
  const values = /^VALUES\s*/i.exec(body.slice(i));
  if (!values) return null;
  i += values[0].length;
  const tuples: string[][] = [];
  for (;;) {
    skipSpace();
    if (body[i] !== "(") return null;
    const close = matchParen(body, i);
    if (close < 0) return null;
    tuples.push(splitTop(body.slice(i + 1, close)).map((t) => t.trim()));
    i = close + 1;
    skipSpace();
    if (body[i] !== ",") break;
    i += 1;
  }
  return body.slice(i).trim() === ";" ? { ref, rawColumns, tuples } : null;
}

/** The text Postgres would read back for a simple literal; undefined when unsure. */
function literalText(token: string): string | null | undefined {
  if (/^null$/i.test(token)) return null;
  if (/^-?\d+(\.\d+)?$/.test(token)) return token;
  if (/^(true|false)$/i.test(token)) return token.toLowerCase();
  const m = /^'((?:[^']|'')*)'(?:\s*::\s*[\w\s."]+)?$/s.exec(token);
  return m ? m[1]!.replace(/''/g, "'") : undefined;
}

function objectNames(table: TableInfo) {
  return new Set([
    ...table.foreignKeys.map((f) => f.name),
    ...table.uniques.map((u) => u.name),
    ...table.indexes.map((i) => i.name),
  ]);
}

/** Where a `--` comment that runs to the end of `part` starts, else its length. */
function trailingComment(part: string) {
  let i = 0;
  while (i < part.length) {
    const comment = skipComment(part, i);
    if (comment >= 0) {
      if (part.startsWith("--", i) && !part.slice(comment).trim()) return i;
      i = comment;
      continue;
    }
    const quoted = skipQuoted(part, i);
    i = quoted >= 0 ? quoted : i + 1;
  }
  return part.length;
}

/** The SQL of a column-list part with its comments taken out. */
const codeOf = (part: string) => {
  let out = "";
  let i = 0;
  while (i < part.length) {
    const comment = skipComment(part, i);
    if (comment >= 0) {
      out += " ";
      i = comment;
      continue;
    }
    const quoted = skipQuoted(part, i);
    if (quoted >= 0) {
      out += part.slice(i, quoted);
      i = quoted;
      continue;
    }
    out += part[i];
    i += 1;
  }
  return out.trim();
};

/**
 * Edits a CREATE TABLE in place: added columns, NOT NULL changes, dropped
 * columns and constraints. Untouched parts keep their exact text, comments
 * and layout included.
 */
function editCreate(body: string, before: TableInfo, after: TableInfo): string | null {
  const head = CREATE_RE.exec(body);
  if (!head) return null;
  const open = head[0].length - 1;
  const close = matchParen(body, open);
  if (close < 0) return null;
  const parts = splitTop(body.slice(open + 1, close));
  const beforeNames = objectNames(before);
  const afterNames = objectNames(after);
  const next: (string | null)[] = [];
  let lastColumn = -1;
  let changed = false;
  for (const part of parts) {
    const text = codeOf(part);
    if (!text) {
      next.push(part);
      continue;
    }
    const named = new RegExp(String.raw`^CONSTRAINT\s+(${ID})`, "i").exec(text);
    if (named) {
      const name = unquote(named[1]!);
      const dropped = beforeNames.has(name) && !afterNames.has(name);
      if (dropped) changed = true;
      next.push(dropped ? null : part);
      continue;
    }
    if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)\b/i.test(text)) {
      next.push(part);
      continue;
    }
    const nameMatch = new RegExp(`^(${ID})`).exec(text);
    if (!nameMatch) return null;
    const name = unquote(nameMatch[1]!);
    const was = before.columns.find((c) => c.name === name);
    const now = after.columns.find((c) => c.name === name);
    if (!was) return null;
    if (!now) {
      changed = true;
      next.push(null);
      continue;
    }
    let edited = text;
    if (was.type !== now.type || was.default !== now.default) edited = columnSql(now);
    else if (was.nullable !== now.nullable) {
      edited = now.nullable ? text.replace(/\s+NOT\s+NULL\b/i, "") : `${text} NOT NULL`;
    }
    if (edited !== text) {
      changed = true;
      // Swap the code and keep the surrounding comments; give up when a
      // comment sits inside the definition itself.
      if (!part.includes(text)) return null;
      next.push(part.replace(text, edited));
    } else next.push(part);
    lastColumn = next.length - 1;
  }
  const added = after.columns.filter((c) => !before.columns.some((b) => b.name === c.name)).map(columnSql);
  if (added.length) {
    changed = true;
    const anchor = next[lastColumn] ?? next[0] ?? "";
    const indent = /\n([ \t]*)\S[^\n]*\s*$/.exec(anchor)?.[1] ?? /^\s*?([ \t]*)\S/.exec(anchor)?.[1] ?? "    ";
    if (lastColumn === next.length - 1) {
      // The last part ends at the closing paren. A comment ending its line
      // stays after the comma that now follows the column; the trailing
      // newline moves after the new columns.
      const comment = trailingComment(anchor);
      const head = anchor.slice(0, comment).replace(/\s+$/, "");
      const rest = anchor.slice(comment);
      const lead = rest.trim() ? ` ${rest.replace(/\s+$/, "")}` : "";
      const tail = /\s*$/.exec(anchor)![0] || "\n";
      next[lastColumn] = head;
      next.splice(
        lastColumn + 1,
        0,
        ...added.map((col, i) => `${i === 0 ? lead : ""}\n${indent}${col}${i === added.length - 1 ? tail : ""}`),
      );
    } else {
      next.splice(lastColumn + 1, 0, ...added.map((col) => `\n${indent}${col}`));
    }
  }
  if (!changed) return body;
  return `${body.slice(0, open + 1)}${next.filter((p): p is string => p !== null).join(",")}${body.slice(close)}`;
}

const keyOf = (row: TextRow, pk: string[]) => JSON.stringify(pk.map((c) => row[c] ?? null));

interface InsertPlan {
  /** Replacement text per statement index; null drops the statement. */
  replace: Map<number, string | null>;
  /** Statements to add after a statement index. */
  extra: [number, string][];
}

/**
 * Patches one table's INSERT statements row by row. Returns null when the
 * statements cannot be matched to rows, and the table is rewritten instead.
 */
function patchInserts(
  indexes: number[],
  statements: Statement[],
  before: TableInfo,
  after: TableInfo,
  beforeRows: TextRow[],
  afterRows: TextRow[],
  anchor: number,
): InsertPlan | null {
  const pk = after.primaryKey;
  if (!pk.length || pk.join() !== before.primaryKey.join()) return null;
  const beforeByKey = new Map(beforeRows.map((row) => [keyOf(row, pk), row]));
  const afterByKey = new Map(afterRows.map((row) => [keyOf(row, pk), row]));
  const afterCols = new Map(after.columns.map((c) => [c.name, c]));
  const seen = new Set<string>();
  const plan: InsertPlan = { replace: new Map(), extra: [] };
  let ref = tableRef(after.name);

  for (const index of indexes) {
    const parsed = parseInsert(statements[index]!.body);
    if (!parsed) return null;
    ref = parsed.ref;
    const columns = parsed.rawColumns?.map(unquote) ?? before.columns.map((c) => c.name);
    if (columns.some((c) => !afterCols.has(c))) return null;
    const rows: { tokens: string[]; was: TextRow; now: TextRow }[] = [];
    let changed = false;
    for (const tokens of parsed.tuples) {
      if (tokens.length !== columns.length) return null;
      const key: (string | null)[] = [];
      for (const column of pk) {
        const at = columns.indexOf(column);
        const value = at < 0 ? undefined : literalText(tokens[at]!);
        if (value === undefined) return null;
        key.push(value);
      }
      const keyText = JSON.stringify(key);
      const was = beforeByKey.get(keyText);
      if (!was || seen.has(keyText)) return null;
      seen.add(keyText);
      const now = afterByKey.get(keyText);
      if (!now) {
        changed = true;
        continue;
      }
      rows.push({ tokens, was, now });
    }
    // Columns the statement leaves out but the migrated row needs spelled out.
    const missing = after.columns.filter(
      (c) =>
        !columns.includes(c.name) &&
        (!before.columns.some((b) => b.name === c.name) || rows.some((r) => r.was[c.name] !== r.now[c.name])),
    );
    const tuples = rows.map(({ tokens, was, now }) => {
      const values = columns.map((column, i) => {
        if (was[column] === now[column]) return tokens[i]!;
        changed = true;
        return valueSql(now[column] ?? null, afterCols.get(column)!.type);
      });
      for (const column of missing) values.push(valueSql(now[column.name] ?? null, column.type));
      return values;
    });
    if (missing.length) changed = true;
    if (!changed) continue;
    if (!tuples.length) {
      plan.replace.set(index, null);
      continue;
    }
    const listed = parsed.rawColumns ?? (missing.length ? before.columns.map((c) => ident(c.name)) : null);
    const columnList = listed ? ` (${[...listed, ...missing.map((c) => ident(c.name))].join(", ")})` : "";
    plan.replace.set(index, `INSERT INTO ${ref}${columnList} VALUES ${tuples.map((t) => `(${t.join(", ")})`).join(", ")};`);
  }

  const added = afterRows.filter((row) => !seen.has(keyOf(row, pk)));
  if (added.length) {
    plan.extra.push([indexes.length ? indexes[indexes.length - 1]! : anchor, added.map((row) => `\n${insertSql(after, row, ref)}`).join("")]);
  }
  return plan;
}

function normalize(snapshot: SchemaSnapshot) {
  return JSON.stringify(
    [...snapshot.tables]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        columns: t.columns,
        primaryKey: t.primaryKey,
        uniques: [...t.uniques].sort((a, b) => a.name.localeCompare(b.name)),
        foreignKeys: [...t.foreignKeys].sort((a, b) => a.name.localeCompare(b.name)),
        indexes: [...t.indexes].sort((a, b) => a.name.localeCompare(b.name)),
      })),
  );
}

/** True when the dump loads into exactly the migrated schema and rows. */
async function reproduces(dump: string, after: PGliteInterface, afterSnap: SchemaSnapshot) {
  let pg: PGlite;
  try {
    pg = await loadSql(dump);
  } catch {
    return false;
  }
  try {
    const snap = await introspect(pg);
    if (normalize(snap) !== normalize(afterSnap)) return false;
    for (const table of afterSnap.tables) {
      const [mine, theirs] = await Promise.all([readRows(pg, table), readRows(after, table)]);
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    await pg.close();
  }
}

/**
 * The original dump, edited to hold the migrated database. Returns null when
 * the dump has a shape this cannot edit safely; callers then write a fresh dump.
 */
export async function patchDump(
  original: string,
  before: PGliteInterface,
  after: PGliteInterface,
): Promise<string | null> {
  const [beforeSnap, afterSnap] = await Promise.all([introspect(before), introspect(after)]);
  const beforeTables = new Map(beforeSnap.tables.map((t) => [t.name, t]));
  const afterTables = new Map(afterSnap.tables.map((t) => [t.name, t]));
  const { statements, tail } = splitStatements(original);
  if (!statements.length) return null;
  const kinds = statements.map((s) => classify(s.body));
  const out: (string | null)[] = statements.map((s) => s.body);
  const extra = new Map<number, string[]>();
  const addAfter = (index: number, text: string) => extra.set(index, [...(extra.get(index) ?? []), text]);

  const createAt = new Map<string, number>();
  const insertsOf = new Map<string, number[]>();
  let lastData = -1;
  for (const [index, kind] of kinds.entries()) {
    if (kind.type === "other") continue;
    const now = afterTables.get(kind.table);
    const was = beforeTables.get(kind.table);
    if (!was) return null;
    if (kind.type === "create" || kind.type === "insert") lastData = index;
    if (!now) {
      out[index] = null;
      continue;
    }
    if (kind.type === "create") {
      createAt.set(kind.table, index);
      const edited = editCreate(statements[index]!.body, was, now);
      if (edited === null) return null;
      out[index] = edited;
    } else if (kind.type === "insert") {
      insertsOf.set(kind.table, [...(insertsOf.get(kind.table) ?? []), index]);
    } else if (objectNames(was).has(kind.name) && !objectNames(now).has(kind.name)) {
      out[index] = null;
    }
  }

  for (const now of afterSnap.tables) {
    const was = beforeTables.get(now.name);
    if (!was) continue;
    const anchor = createAt.get(now.name);
    if (anchor === undefined) return null;
    const indexes = insertsOf.get(now.name) ?? [];
    const [beforeRows, afterRows] = await Promise.all([readRows(before, was), readRows(after, now)]);
    const plan = patchInserts(indexes, statements, was, now, beforeRows, afterRows, anchor);
    if (plan) {
      for (const [index, text] of plan.replace) out[index] = text;
      for (const [index, text] of plan.extra) addAfter(index, text);
      continue;
    }
    // Rows could not be matched one by one: rewrite this table's data.
    for (const index of indexes) out[index] = null;
    if (afterRows.length) {
      addAfter(indexes[0] ?? anchor, afterRows.map((row) => `\n${insertSql(now, row)}`).join(""));
    }
  }

  const fresh = parentsFirst(afterSnap).filter((t) => !beforeTables.has(t.name));
  if (fresh.length && lastData < 0) return null;
  for (const table of fresh) {
    const rows = await readRows(after, table);
    addAfter(lastData, `\n\n${createTableSql(table)}${rows.length ? "\n\n" : ""}${rows.map((row) => insertSql(table, row)).join("\n")}`);
  }

  const constraints: string[] = [];
  for (const now of afterSnap.tables) {
    const was = beforeTables.get(now.name);
    const existing = was ? objectNames(was) : new Set<string>();
    if (was) {
      for (const unique of uniqueConstraints(now)) if (!existing.has(unique.name)) constraints.push(uniqueSql(now.name, unique));
    }
    for (const fk of now.foreignKeys) if (!existing.has(fk.name)) constraints.push(foreignKeySql(now.name, fk));
    for (const index of now.indexes) if (!existing.has(index.name)) constraints.push(`${index.definition};`);
  }
  if (constraints.length) addAfter(statements.length - 1, `\n\n${constraints.join("\n")}`);

  let dump = "";
  for (const [index, statement] of statements.entries()) {
    const text = out[index];
    if (text !== null && text !== undefined) dump += statement.lead + text;
    for (const added of extra.get(index) ?? []) dump += added;
  }
  dump += tail;
  // Keep the file's own ending: with or without a final newline.
  if (original.endsWith("\n") && !dump.endsWith("\n")) dump += "\n";
  if (!original.endsWith("\n")) dump = dump.replace(/\n+$/, "");
  return (await reproduces(dump, after, afterSnap)) ? dump : null;
}
