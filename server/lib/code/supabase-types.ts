import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { activeItems, fkName, fkNaming, type ChangeItem, type ColumnSpec } from "../../../shared/changes.js";
import type { SchemaSnapshot } from "../../../shared/schema-types.js";

// Supabase repos keep `supabase gen types` output (a `Database` type with
// Row/Insert/Update per table) in the repo, and the client is typed with it.
// Shipping a schema change without updating it lets tsc pass on code the new
// schema breaks, so the changeset edits it the way a regenerate would.

// ---------------------------------------------------------------- encoding

/** A file's text plus how it was stored, so edits write it back the same way. */
export interface StoredText {
  text: string;
  utf16: boolean;
  bom: boolean;
  crlf: boolean;
}

export function decodeText(buf: Buffer): StoredText {
  const utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  const utf8Bom = !utf16 && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const raw = utf16 ? buf.subarray(2).toString("utf16le") : buf.subarray(utf8Bom ? 3 : 0).toString("utf8");
  const crlf = /\r\n/.test(raw);
  return { text: crlf ? raw.replace(/\r\n/g, "\n") : raw, utf16, bom: utf16 || utf8Bom, crlf };
}

export function encodeText(stored: StoredText, text: string): Buffer {
  const body = stored.crlf ? text.replace(/\n/g, "\r\n") : text;
  if (stored.utf16) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]);
  return Buffer.concat([stored.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(body, "utf8")]);
}

// ---------------------------------------------------------------- finding

const SKIP = /^(node_modules|\.git|\.next|dist|build|coverage|\.turbo|data)$/;
const ROOT = /(?:export\s+)?(?:type|interface)\s+Database\s*=?\s*\{/;
const looksGenerated = (text: string) => ROOT.test(text) && /\bTables:\s*\{/.test(text) && /\bRow:\s*\{/.test(text);

/** Repo-relative paths of generated Supabase `Database` type files. */
export async function findSupabaseTypes(repoPath: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.test(entry.name)) await walk(full, depth + 1);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) {
        const size = (await stat(full)).size;
        if (size > 3_000_000) continue;
        const { text } = decodeText(await readFile(full));
        if (looksGenerated(text)) found.push(path.relative(repoPath, full).split(path.sep).join("/"));
      }
    }
  };
  await walk(repoPath, 0);
  return found.sort();
}

// ---------------------------------------------------------------- parsing

/** Index of the bracket closing the one at `open`, skipping strings and comments. */
function blockEnd(text: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const stack = [pairs[text[open]!]!];
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
    } else if (ch === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return text.length;
    } else if (pairs[ch]) stack.push(pairs[ch]!);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return text.length;
}

interface Member {
  name: string;
  optional: boolean;
  /** Start of the member's first line, and end of its last (at the newline). */
  start: number;
  end: number;
  indent: string;
  /** Index of the value's `{` or `[`, when it has one. */
  open: number | null;
  value: string;
}

const lineEnd = (text: string, i: number) => {
  const n = text.indexOf("\n", i);
  return n < 0 ? text.length : n;
};
const lineStart = (text: string, i: number) => text.lastIndexOf("\n", i - 1) + 1;
const indentAt = (text: string, i: number) => /^[ \t]*/.exec(text.slice(lineStart(text, i)))![0];

/** The top-level members of the object literal type opening at `open`. */
function members(text: string, open: number): Member[] {
  const close = blockEnd(text, open);
  const out: Member[] = [];
  let i = lineEnd(text, open) + 1;
  while (i < close) {
    const le = lineEnd(text, i);
    const m = /^([ \t]*)(?:"([^"]+)"|([\w$]+))(\?)?:[ \t]*/.exec(text.slice(i, le));
    if (!m) {
      i = le + 1;
      continue;
    }
    const valueAt = i + m[0].length;
    const ch = text[valueAt];
    const opens = ch === "{" || ch === "[";
    const end = opens ? lineEnd(text, blockEnd(text, valueAt)) : le;
    out.push({
      name: m[2] ?? m[3]!,
      optional: Boolean(m[4]),
      start: i,
      end,
      indent: m[1]!,
      open: opens ? valueAt : null,
      value: text.slice(valueAt, end).trim(),
    });
    i = end + 1;
  }
  return out;
}

const child = (text: string, open: number, name: string) => members(text, open).find((m) => m.name === name);

/** Object elements `{ ... }` of the array opening at `open`. */
function elements(text: string, open: number) {
  const close = blockEnd(text, open);
  const out: { start: number; end: number; text: string }[] = [];
  for (let i = open + 1; i < close; i++) {
    if (text[i] !== "{") continue;
    const end = blockEnd(text, i);
    const after = text[end + 1] === "," ? end + 2 : end + 1;
    out.push({ start: lineStart(text, i), end: lineEnd(text, after - 1), text: text.slice(i, after) });
    i = end;
  }
  return out;
}

// ---------------------------------------------------------------- types

const NUMBER = /^(smallint|integer|int|int2|int4|int8|bigint|numeric|decimal|real|double precision|float4|float8|serial|bigserial|smallserial|money|oid)$/;
const BOOLEAN = /^(boolean|bool)$/;
const JSON_TYPE = /^(json|jsonb)$/;

function tsType(pgType: string, schema: string, enums: Set<string>): string {
  let type = pgType.trim();
  let array = false;
  if (type.endsWith("[]")) {
    array = true;
    type = type.slice(0, -2);
  }
  type = type.replace(/\s*\(.*\)$/, "").replace(/^"(.*)"$/, "$1");
  const bare = type.replace(/^[\w$]+\./, "");
  const lower = bare.toLowerCase();
  const base = NUMBER.test(lower)
    ? "number"
    : BOOLEAN.test(lower)
      ? "boolean"
      : JSON_TYPE.test(lower)
        ? "Json"
        : enums.has(bare)
          ? `Database["${schema}"]["Enums"]["${bare}"]`
          : /^(text|varchar|character varying|char|character|bpchar|uuid|citext|name|date|time|timetz|timestamp|timestamptz|interval|inet|cidr|macaddr|bytea|tsvector|tsquery|vector|ltree|xml)$/.test(lower) ||
              /^(time|timestamp)\b/.test(lower)
            ? "string"
            : "unknown";
  return array ? `${base}[]` : base;
}

// ---------------------------------------------------------------- editing

interface Style {
  /** One indent step, e.g. two spaces. */
  step: string;
  /** "" or ";" after each member, as the file has it. */
  sep: string;
}

function detectStyle(text: string): Style {
  const row = /\n([ \t]*)Row:\s*\{\n([ \t]*)[^\n]*?([;,]?)\n/.exec(text);
  const step = row ? row[2]!.slice(row[1]!.length) || "  " : "  ";
  return { step, sep: row?.[3] === ";" ? ";" : "" };
}

function insertAt(text: string, at: number, insert: string) {
  return text.slice(0, at) + insert + text.slice(at);
}

/** Inserts member lines into an object, keeping the generator's alphabetical order. */
function addMember(text: string, open: number, name: string, lines: string[], style: Style): string {
  const list = members(text, open);
  const existing = list.find((m) => m.name === name);
  if (existing) text = text.slice(0, existing.start) + text.slice(existing.end + 1);
  const fresh = members(text, open);
  const indent = fresh[0]?.indent ?? indentAt(text, open) + style.step;
  // An empty generated block reads `[_ in never]: never`; it gives way.
  const close = blockEnd(text, open);
  const body = text.slice(open + 1, close);
  if (!fresh.length && /\[_ in never\]:\s*never/.test(body)) {
    text = text.slice(0, open + 1) + `\n${indentAt(text, open)}` + text.slice(close);
  }
  const before = members(text, open).find((m) => m.name > name);
  const at = before ? before.start : lineStart(text, blockEnd(text, open));
  return insertAt(text, at, lines.map((l) => `${indent}${l}\n`).join(""));
}

function columnLines(
  column: { name: string; type: string; nullable: boolean; hasDefault: boolean },
  schema: string,
  enums: Set<string>,
  style: Style,
) {
  const type = tsType(column.type, schema, enums) + (column.nullable ? " | null" : "");
  return {
    row: `${column.name}: ${type}${style.sep}`,
    insert: `${column.name}${column.nullable || column.hasDefault ? "?" : ""}: ${type}${style.sep}`,
    update: `${column.name}?: ${type}${style.sep}`,
  };
}

function relationshipBlock(
  r: { name: string; column: string; refTable: string; refColumn: string; oneToOne: boolean },
  indent: string,
  style: Style,
  comma: string,
) {
  const inner = indent + style.step;
  return [
    `${indent}{`,
    `${inner}foreignKeyName: "${r.name}"${style.sep}`,
    `${inner}columns: ["${r.column}"]${style.sep}`,
    `${inner}isOneToOne: ${r.oneToOne}${style.sep}`,
    `${inner}referencedRelation: "${r.refTable}"${style.sep}`,
    `${inner}referencedColumns: ["${r.refColumn}"]${style.sep}`,
    `${indent}}${comma}`,
  ].join("\n");
}

function addRelationship(text: string, table: Member, rel: Parameters<typeof relationshipBlock>[0], style: Style): string {
  const relationships = child(text, table.open!, "Relationships");
  if (!relationships?.open) return text;
  const open = relationships.open;
  const close = blockEnd(text, open);
  const list = elements(text, open);
  if (list.some((e) => e.text.includes(`"${rel.name}"`))) return text;
  const indent = relationships.indent + style.step;
  if (!list.length) {
    const block = relationshipBlock(rel, indent, style, style.sep === ";" ? "," : "");
    return `${text.slice(0, open)}[\n${block}\n${relationships.indent}]${text.slice(close + 1)}`;
  }
  // Newer generators end every element with a comma; older ones separate them.
  const last = list[list.length - 1]!;
  const trailing = last.text.endsWith(",");
  let out = text;
  let at = last.end;
  if (!trailing) {
    const brace = out.lastIndexOf("}", at);
    out = insertAt(out, brace + 1, ",");
    at += 1;
  }
  return insertAt(out, at, `\n${relationshipBlock(rel, indent, style, trailing ? "," : "")}`);
}

function dropRelationship(text: string, table: Member, constraint: string): string {
  const relationships = child(text, table.open!, "Relationships");
  if (!relationships?.open) return text;
  const list = elements(text, relationships.open);
  const index = list.findIndex((e) => e.text.includes(`foreignKeyName: "${constraint}"`));
  if (index < 0) return text;
  const target = list[index]!;
  if (list.length === 1) {
    const close = blockEnd(text, relationships.open);
    return `${text.slice(0, relationships.open)}[]${text.slice(close + 1)}`;
  }
  let out = text.slice(0, target.start) + text.slice(target.end + 1);
  // Without trailing commas, the new last element must lose its separator.
  if (index === list.length - 1 && !target.text.endsWith(",")) {
    const prev = list[index - 1]!;
    const comma = out.lastIndexOf(",", prev.end);
    if (comma > prev.start) out = out.slice(0, comma) + out.slice(comma + 1);
  }
  return out;
}

function editLine(text: string, block: Member | undefined, name: string, edit: (line: string) => string): string {
  if (!block?.open) return text;
  const member = members(text, block.open).find((m) => m.name === name);
  if (!member) return text;
  return text.slice(0, member.start) + edit(text.slice(member.start, member.end)) + text.slice(member.end);
}

const splitName = (table: string): [string, string] => {
  const dot = table.indexOf(".");
  return dot < 0 ? ["public", table] : [table.slice(0, dot), table.slice(dot + 1)];
};

/**
 * Applies a changeset to a generated Supabase types file. Returns the new
 * text and notes for anything it could not place (a table missing from the
 * file means the file is stale; regenerating it is then the safe fix).
 */
export function generateSupabaseTypes(
  text: string,
  items: ChangeItem[],
  snapshot: SchemaSnapshot,
): { text: string; notes: string[] } {
  const rootMatch = ROOT.exec(text);
  if (!rootMatch) return { text, notes: ["No Database type found in the Supabase types file."] };
  const rootOpen = rootMatch.index + rootMatch[0].length - 1;
  const style = detectStyle(text);
  const notes: string[] = [];
  const naming = fkNaming(snapshot);
  const columnDefault = (table: string, column: string) =>
    snapshot.tables.find((t) => t.name === table)?.columns.find((c) => c.name === column)?.default ?? null;
  const uniqueColumns = (table: string) => {
    const t = snapshot.tables.find((x) => x.name === table);
    return new Set([...(t?.primaryKey.length === 1 ? t.primaryKey : []), ...(t?.uniques.filter((u) => u.columns.length === 1 && !u.expression).map((u) => u.columns[0]!) ?? [])]);
  };

  const locate = (table: string) => {
    const [schema, name] = splitName(table);
    const schemaBlock = child(text, rootOpen, schema);
    const tables = schemaBlock?.open != null ? child(text, schemaBlock.open, "Tables") : undefined;
    const enumsBlock = schemaBlock?.open != null ? child(text, schemaBlock.open, "Enums") : undefined;
    const enums = new Set(enumsBlock?.open != null ? members(text, enumsBlock.open).map((m) => m.name) : []);
    const block = tables?.open != null ? child(text, tables.open, name) : undefined;
    return { schema, name, tables, block, enums };
  };

  const addColumn = (table: string, column: ColumnSpec) => {
    const at = locate(table);
    if (!at.block?.open) return notes.push(`${table} is not in the Supabase types file; regenerate it with supabase gen types.`);
    const lines = columnLines(
      { name: column.name, type: column.type, nullable: column.nullable, hasDefault: Boolean(column.default) || Boolean(column.primaryKey && column.default) },
      at.schema,
      at.enums,
      style,
    );
    for (const [key, line] of [["Row", lines.row], ["Insert", lines.insert], ["Update", lines.update]] as const) {
      const fresh = locate(table).block!;
      const part = child(text, fresh.open!, key);
      if (part?.open != null) text = addMember(text, part.open, column.name, [line], style);
    }
    return 0;
  };

  const addFk = (table: string, column: string, refTable: string, refColumn: string, oneToOne: boolean) => {
    const at = locate(table);
    if (!at.block?.open) return;
    const [refSchema, refName] = splitName(refTable);
    if (refSchema !== at.schema) return;
    text = addRelationship(text, at.block, { name: fkName(table, column, refTable, refColumn, naming), column, refTable: refName, refColumn, oneToOne }, style);
  };

  for (const item of [...activeItems(items)].sort((a, b) => a.position - b.position)) {
    const p = item.payload;
    switch (p.kind) {
      case "add_column":
        addColumn(p.table, p.column);
        if (p.column.references) addFk(p.table, p.column.name, p.column.references.table, p.column.references.column, false);
        break;
      case "create_table": {
        const at = locate(p.table);
        if (!at.tables?.open) {
          notes.push(`The ${at.schema} schema is not in the Supabase types file; regenerate it with supabase gen types.`);
          break;
        }
        const s = style.step;
        const lines = p.columns.map((c) =>
          columnLines({ name: c.name, type: c.type, nullable: c.nullable && !c.primaryKey, hasDefault: Boolean(c.default) }, at.schema, at.enums, style),
        );
        const sorted = (key: "row" | "insert" | "update") => lines.map((l) => l[key]).sort((a, b) => (a < b ? -1 : 1));
        const block = [
          `${at.name}: {`,
          `${s}Row: {`,
          ...sorted("row").map((l) => `${s}${s}${l}`),
          `${s}}`,
          `${s}Insert: {`,
          ...sorted("insert").map((l) => `${s}${s}${l}`),
          `${s}}`,
          `${s}Update: {`,
          ...sorted("update").map((l) => `${s}${s}${l}`),
          `${s}}`,
          `${s}Relationships: []`,
          `}`,
        ];
        text = addMember(text, at.tables.open, at.name, block, style);
        for (const c of p.columns) {
          if (c.references) addFk(p.table, c.name, c.references.table, c.references.column, Boolean(c.primaryKey));
        }
        break;
      }
      case "set_not_null": {
        const at = locate(p.table);
        if (!at.block?.open) {
          notes.push(`${p.table} is not in the Supabase types file; regenerate it with supabase gen types.`);
          break;
        }
        const hasDefault = Boolean(columnDefault(p.table, p.column));
        text = editLine(text, child(text, at.block.open, "Row"), p.column, (l) => l.replace(/\s*\|\s*null(?=[;,]?\s*$)/, ""));
        const insert = child(text, locate(p.table).block!.open!, "Insert");
        text = editLine(text, insert, p.column, (l) => {
          const typed = l.replace(/\s*\|\s*null(?=[;,]?\s*$)/, "");
          return hasDefault ? typed : typed.replace(/\?:/, ":");
        });
        const update = child(text, locate(p.table).block!.open!, "Update");
        text = editLine(text, update, p.column, (l) => l.replace(/\s*\|\s*null(?=[;,]?\s*$)/, ""));
        break;
      }
      case "add_foreign_key":
        addFk(p.table, p.column, p.refTable, p.refColumn, uniqueColumns(p.table).has(p.column));
        break;
      case "drop_foreign_key": {
        const at = locate(p.table);
        if (at.block?.open) text = dropRelationship(text, at.block, p.constraint);
        break;
      }
      default:
        // Uniques, indexes and backfills do not change the generated types.
        break;
    }
  }
  return { text, notes: [...new Set(notes)] };
}
