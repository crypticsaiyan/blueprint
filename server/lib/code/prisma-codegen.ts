import type { ChangeItem, ColumnSpec } from "../../../shared/changes.js";
import { activeItems } from "../../../shared/changes.js";

// Keeps schema.prisma in step with the shipped migration. Without it, the
// next `prisma migrate dev` sees the database ahead of the schema and writes a
// migration that undoes the change. Edits are textual and leave every
// untouched line as it was.

interface Field {
  name: string;
  column: string;
  /** Line index in the file. */
  line: number;
}

interface Model {
  name: string;
  table: string;
  file: string;
  /** Line indexes of `model X {` and its closing `}`. */
  start: number;
  end: number;
  fields: Field[];
  /** True when the model maps snake_case columns to camelCase fields. */
  mapsColumns: boolean;
  /** Columns where `prisma format` starts field types and attributes here. */
  typeCol: number;
  attrCol: number;
}

export interface PrismaCodegenResult {
  files: Map<string, string>;
  /** Changes the schema could not express, for the reviewer. */
  notes: string[];
}

const pascal = (s: string) => s.replace(/(^|[_\s-]+)(\w)/g, (_, __, c: string) => c.toUpperCase());
const camel = (s: string) => {
  const p = pascal(s);
  return p[0]!.toLowerCase() + p.slice(1);
};
const singular = (s: string) => (/ies$/.test(s) ? s.replace(/ies$/, "y") : /([^s])s$/.test(s) ? s.slice(0, -1) : s);

function parse(files: Map<string, string[]>): Model[] {
  const models: Model[] = [];
  for (const [file, lines] of files) {
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i]!.match(/^\s*model\s+(\w+)\s*\{/);
      if (!head) continue;
      let end = i + 1;
      while (end < lines.length && !/^\s*\}/.test(lines[end]!)) end++;
      const fields: Field[] = [];
      let table = head[1]!;
      let mapsColumns = false;
      for (let j = i + 1; j < end; j++) {
        const line = lines[j]!;
        const map = line.match(/@@map\(\s*(?:name:\s*)?"([^"]+)"/);
        if (map) table = map[1]!;
        const field = line.match(/^\s*(\w+)\s+\w+/);
        if (!field || /^\s*(\/\/|@@)/.test(line)) continue;
        const column = line.match(/@map\(\s*(?:name:\s*)?"([^"]+)"/)?.[1];
        if (column && column !== field[1]) mapsColumns = true;
        fields.push({ name: field[1]!, column: column ?? field[1]!, line: j });
      }
      let typeCol = 0;
      let attrCol = 0;
      for (let j = i + 1; j < end; j++) {
        const m = lines[j]!.match(/^(\s*\w+\s+)(\S+\s+)?(@.*)?$/);
        if (!m || /^\s*@@/.test(lines[j]!)) continue;
        typeCol = Math.max(typeCol, m[1]!.length);
        if (m[3] && m[2]) attrCol = Math.max(attrCol, m[1]!.length + m[2].length);
      }
      models.push({ name: head[1]!, table, file, start: i, end, fields, mapsColumns, typeCol, attrCol });
    }
  }
  return models;
}

/** Prisma type and native-type attribute for a Postgres type. */
function prismaType(pgType: string): { type: string; native: string } {
  const t = pgType.trim().toLowerCase();
  const n = t.match(/\((\d+(?:,\s*\d+)?)\)/)?.[1];
  if (/^(text)$/.test(t)) return { type: "String", native: "" };
  if (/^(varchar|character varying)/.test(t)) return { type: "String", native: n ? `@db.VarChar(${n})` : "" };
  if (/^(char|character)\b/.test(t)) return { type: "String", native: `@db.Char(${n ?? 1})` };
  if (t === "uuid") return { type: "String", native: "@db.Uuid" };
  if (/^(integer|int|int4|serial)$/.test(t)) return { type: "Int", native: "" };
  if (/^(smallint|int2)$/.test(t)) return { type: "Int", native: "@db.SmallInt" };
  if (/^(bigint|int8|bigserial)$/.test(t)) return { type: "BigInt", native: "" };
  if (/^(boolean|bool)$/.test(t)) return { type: "Boolean", native: "" };
  if (/^(timestamptz|timestamp with time zone)/.test(t)) return { type: "DateTime", native: "@db.Timestamptz(6)" };
  if (/^timestamp/.test(t)) return { type: "DateTime", native: n ? `@db.Timestamp(${n})` : "" };
  if (t === "date") return { type: "DateTime", native: "@db.Date" };
  if (t === "jsonb") return { type: "Json", native: "" };
  if (t === "json") return { type: "Json", native: "@db.Json" };
  if (/^(numeric|decimal)/.test(t)) return { type: "Decimal", native: n ? `@db.Decimal(${n})` : "" };
  if (/^(real|float4)$/.test(t)) return { type: "Float", native: "@db.Real" };
  if (/^(double precision|float8)$/.test(t)) return { type: "Float", native: "" };
  if (t === "bytea") return { type: "Bytes", native: "" };
  return { type: `Unsupported("${pgType}")`, native: "" };
}

function prismaDefault(expr: string | null | undefined, type: string) {
  if (expr === null || expr === undefined) return "";
  const e = expr.trim();
  if (/^now\(\)$|^current_timestamp$/i.test(e)) return "@default(now())";
  if (/^(true|false)$/i.test(e) && type === "Boolean") return `@default(${e.toLowerCase()})`;
  if (/^-?\d+(\.\d+)?$/.test(e) && /^(Int|BigInt|Float|Decimal)$/.test(type)) return `@default(${e})`;
  const str = e.match(/^'((?:[^']|'')*)'(?:::\w+)?$/);
  if (str && type === "String") return `@default(${JSON.stringify(str[1]!.replace(/''/g, "'"))})`;
  return `@default(dbgenerated(${JSON.stringify(e)}))`;
}

/** Pads `  name type @attrs` to the given columns, as `prisma format` would. */
function align(line: string, typeCol: number, attrCol: number) {
  const m = line.match(/^\s*(\w+)\s+(\S+)(?:\s+(@.*))?$/);
  if (!m) return line;
  const head = `  ${m[1]} `.padEnd(typeCol);
  if (!m[3]) return `${head}${m[2]}`;
  return `${`${head}${m[2]} `.padEnd(attrCol)}${m[3]}`;
}

/** Widths for a new model: longest name and type plus one space. */
function blockWidths(lines: string[]) {
  const parsed = lines.map((l) => l.match(/^\s*(\w+)\s+(\S+)/)).filter((m): m is RegExpMatchArray => Boolean(m));
  const typeCol = 2 + Math.max(...parsed.map((m) => m[1]!.length)) + 1;
  return { typeCol, attrCol: typeCol + Math.max(...parsed.map((m) => m[2]!.length)) + 1 };
}

const ON_DELETE: Record<string, string> = { cascade: "Cascade", "set null": "SetNull", restrict: "Restrict", "no action": "NoAction" };

export function generatePrismaSchema(sources: Map<string, string>, items: ChangeItem[]): PrismaCodegenResult {
  const files = new Map([...sources].map(([f, t]) => [f, t.split("\n")]));
  const notes: string[] = [];
  // Inserted lines, keyed by file and the line they go before; applied last
  // so line numbers found while parsing stay valid.
  const inserts = new Map<string, Map<number, string[]>>();
  const appended: { file: string; text: string }[] = [];
  const insert = (file: string, before: number, text: string) => {
    const byLine = inserts.get(file) ?? new Map<number, string[]>();
    byLine.set(before, [...(byLine.get(before) ?? []), text]);
    inserts.set(file, byLine);
  };
  const edit = (file: string, line: number, fn: (text: string) => string) => {
    const lines = files.get(file)!;
    lines[line] = fn(lines[line]!);
  };
  // Lines dropped from the output, kept in place until then for the same reason.
  const removed = new Map<string, Set<number>>();
  const remove = (file: string, line: number) => removed.set(file, (removed.get(file) ?? new Set()).add(line));
  const models = parse(files);
  const primary = [...files.keys()].find((f) => /schema\.prisma$/.test(f)) ?? [...files.keys()][0]!;
  const byTable = (table: string) => models.find((m) => m.table === table);
  const fieldFor = (model: Model, column: string) => model.fields.find((f) => f.column === column);
  /** New fields go after the existing ones, before the block attributes. */
  const fieldAt = (model: Model) => {
    const lines = files.get(model.file)!;
    let at = model.end;
    for (let j = model.start + 1; j < model.end; j++) {
      if (/^\s*@@/.test(lines[j]!)) {
        at = j;
        break;
      }
    }
    while (at > model.start + 1 && /^\s*$/.test(lines[at - 1]!)) at--;
    return at;
  };
  /** Field columns of the run of field lines just above `at`, which `prisma format` aligns together. */
  const segmentWidths = (model: Model, at: number) => {
    const lines = files.get(model.file)!;
    let typeCol = 0;
    let attrCol = 0;
    for (let j = at - 1; j > model.start; j--) {
      const m = lines[j]!.match(/^(\s*\w+\s+)(\S+\s+)?(@.*)?$/);
      if (!m || /^\s*(@@|\/\/)/.test(lines[j]!)) break;
      typeCol = Math.max(typeCol, m[1]!.length);
      if (m[3] && m[2]) attrCol = Math.max(attrCol, m[1]!.length + m[2].length);
    }
    return typeCol ? { typeCol, attrCol: attrCol || model.attrCol || typeCol + 16 } : { typeCol: model.typeCol, attrCol: model.attrCol };
  };
  const addField = (model: Model, line: string) => {
    const at = fieldAt(model);
    const { typeCol, attrCol } = segmentWidths(model, at);
    insert(model.file, at, typeCol ? align(line, typeCol, attrCol) : line);
  };
  /** Block attributes go last, before `@@map` when the model ends with it. */
  const addBlockAttribute = (model: Model, line: string) => {
    const lines = files.get(model.file)!;
    const map = lines.slice(model.start, model.end).findIndex((l) => /^\s*@@map\(/.test(l));
    insert(model.file, map >= 0 && map + model.start === model.end - 1 ? model.end - 1 : model.end, line);
  };
  // Models that map snake_case columns get camelCase fields with @map.
  const fieldName = (model: Pick<Model, "mapsColumns">, column: string) => (model.mapsColumns ? camel(column) : column);
  const mapAttr = (field: string, column: string) => (field === column ? "" : ` @map("${column}")`);
  // Fields added to models that do not exist in the files yet.
  const added = new Map<string, { model: string; fields: string[]; attrs: string[]; mapsColumns: boolean }>();
  const shapeOf = (table: string) => byTable(table) ?? added.get(table) ?? { mapsColumns: false };

  const fieldLine = (model: Pick<Model, "mapsColumns">, column: ColumnSpec, extra = "") => {
    const name = fieldName(model, column.name);
    const { type, native } = prismaType(column.type);
    const parts = [
      `${name} ${type}${column.nullable === false || column.primaryKey ? "" : "?"}`,
      column.primaryKey ? "@id" : "",
      prismaDefault(column.default, type),
      mapAttr(name, column.name).trim(),
      native,
      extra,
    ].filter(Boolean);
    return `  ${parts.join(" ")}`;
  };

  /** Adds the relation field and its back-relation for a foreign key. */
  const relate = (table: string, column: string, refTable: string, refColumn: string, onDelete: string) => {
    const from = byTable(table) ?? null;
    const fromNew = added.get(table);
    const to = byTable(refTable);
    const toNew = added.get(refTable);
    const fromName = from?.name ?? fromNew?.model;
    const toName = to?.name ?? toNew?.model;
    if (!fromName || !toName) {
      notes.push(`Relation ${table}.${column} -> ${refTable} is not in schema.prisma; add it by hand.`);
      return;
    }
    const scalar = (from ? fieldFor(from, column)?.name : undefined) ?? fieldName(shapeOf(table), column);
    const refField = to ? (fieldFor(to, refColumn)?.name ?? refColumn) : fieldName(shapeOf(refTable), refColumn);
    const taken = new Set([...(from?.fields.map((f) => f.name) ?? []), ...(fromNew?.fields.map((f) => f.trim().split(/\s/)[0]!) ?? [])]);
    let relName = camel(column.replace(/_?id$/i, "")) || camel(refTable);
    if (taken.has(relName)) relName = `${relName}Ref`;
    // Two relations between the same models need names to tell them apart.
    const fromText = from ? files.get(from.file)!.slice(from.start, from.end).join("\n") : (fromNew?.fields.join("\n") ?? "");
    const named = new RegExp(`\\s${toName}\\??\\s`).test(fromText) || table === refTable;
    const label = named ? `"${fromName}${pascal(relName)}", ` : "";
    const optional = (() => {
      if (from) {
        const f = fieldFor(from, column);
        return f ? /^\s*\w+\s+\w+\?/.test(files.get(from.file)![f.line]!) : true;
      }
      const line = fromNew?.fields.find((f) => f.trim().startsWith(`${scalar} `));
      return line ? /^\s*\w+\s+\w+\?/.test(line) : true;
    })();
    const relLine = `  ${relName} ${toName}${optional ? "?" : ""} @relation(${label}fields: [${scalar}], references: [${refField}], onDelete: ${ON_DELETE[onDelete] ?? "NoAction"})`;
    if (from) addField(from, relLine);
    else fromNew!.fields.push(relLine);
    const backTaken = new Set(to?.fields.map((f) => f.name) ?? []);
    let back = camel(table);
    if (backTaken.has(back)) back = `${back}${pascal(relName)}`;
    const backLine = `  ${back} ${fromName}[]${label ? ` @relation("${fromName}${pascal(relName)}")` : ""}`;
    if (to) addField(to, backLine);
    else toNew!.fields.push(backLine);
  };

  const ordered = [...activeItems(items)].sort((a, b) => a.position - b.position);
  // A column added and then made required or unique in the same changeset is
  // written that way once, since the new field has no line to edit yet.
  const madeRequired = new Set(ordered.flatMap((i) => (i.payload.kind === "set_not_null" ? [`${i.payload.table}.${i.payload.column}`] : [])));
  const madeUnique = new Set(
    ordered.flatMap((i) =>
      i.payload.kind === "add_unique" && i.payload.columns.length === 1 && !i.payload.caseInsensitive ? [`${i.payload.table}.${i.payload.columns[0]}`] : [],
    ),
  );
  const newColumns = new Set(
    ordered.flatMap((i) =>
      i.payload.kind === "add_column"
        ? [`${i.payload.table}.${i.payload.column.name}`]
        : i.payload.kind === "create_table"
          ? i.payload.columns.map((c) => `${(i.payload as { table: string }).table}.${c.name}`)
          : [],
    ),
  );
  const asNew = (table: string, c: ColumnSpec) => ({
    column: madeRequired.has(`${table}.${c.name}`) ? { ...c, nullable: false } : c,
    extra: madeUnique.has(`${table}.${c.name}`) && !c.primaryKey ? "@unique" : "",
  });

  for (const item of ordered) {
    const p = item.payload;
    switch (p.kind) {
      case "create_table": {
        const name = pascal(singular(p.table));
        const mapsColumns = models.some((m) => m.mapsColumns);
        const shape = { mapsColumns };
        const pk = p.columns.filter((c) => c.primaryKey);
        const fields = p.columns.map((c) => {
          const { column, extra } = asNew(p.table, pk.length > 1 ? { ...c, primaryKey: false, nullable: false } : c);
          return fieldLine(shape, column, extra);
        });
        const attrs = [
          ...(pk.length > 1 ? [`  @@id([${pk.map((c) => fieldName(shape, c.name)).join(", ")}])`] : []),
          ...(name !== p.table ? [`  @@map("${p.table}")`] : []),
        ];
        added.set(p.table, { model: name, fields, attrs, mapsColumns });
        for (const c of p.columns) {
          if (c.references) relate(p.table, c.name, c.references.table, c.references.column, c.references.onDelete);
        }
        break;
      }
      case "add_column": {
        const model = byTable(p.table);
        if (!model) {
          const fresh = added.get(p.table);
          if (fresh) {
            const { column, extra } = asNew(p.table, p.column);
            fresh.fields.push(fieldLine(fresh, column, extra));
          }
          else notes.push(`${p.table} has no model in schema.prisma; add ${p.column.name} by hand.`);
          break;
        }
        const { column, extra } = asNew(p.table, p.column);
        addField(model, fieldLine(model, column, extra));
        model.fields.push({ name: fieldName(model, p.column.name), column: p.column.name, line: -1 });
        if (p.column.references) relate(p.table, p.column.name, p.column.references.table, p.column.references.column, p.column.references.onDelete);
        break;
      }
      case "set_not_null": {
        if (newColumns.has(`${p.table}.${p.column}`)) break;
        const model = byTable(p.table);
        const field = model && fieldFor(model, p.column);
        if (model && field && field.line >= 0) edit(model.file, field.line, (t) => t.replace(/^(\s*\w+\s+\w+(?:\([^)]*\))?)\?/, "$1"));
        else if (!model || !field) notes.push(`Could not find ${p.table}.${p.column} in schema.prisma to make it required.`);
        break;
      }
      case "add_unique":
      case "add_index": {
        const model = byTable(p.table);
        if (p.kind === "add_unique" && p.caseInsensitive) {
          notes.push(`Prisma cannot express the case-insensitive unique on ${p.table} (${p.columns.join(", ")}); the migration keeps it.`);
          break;
        }
        // Written inline as @unique on the new field already.
        if (p.kind === "add_unique" && p.columns.length === 1 && madeUnique.has(`${p.table}.${p.columns[0]}`) && newColumns.has(`${p.table}.${p.columns[0]}`)) break;
        if (!model) {
          const fresh = added.get(p.table);
          const names = p.columns.map((c) => fieldName(shapeOf(p.table), c));
          if (fresh) fresh.attrs.push(`  @@${p.kind === "add_unique" ? "unique" : "index"}([${names.join(", ")}])`);
          else notes.push(`${p.table} has no model in schema.prisma.`);
          break;
        }
        const names = p.columns.map((c) => fieldFor(model, c)?.name ?? c);
        const single = p.kind === "add_unique" && p.columns.length === 1 ? fieldFor(model, p.columns[0]!) : undefined;
        if (single && single.line >= 0) edit(model.file, single.line, (t) => t.replace(/\s*(\/\/.*)?$/, (tail) => ` @unique${tail}`));
        else addBlockAttribute(model, `  @@${p.kind === "add_unique" ? "unique" : "index"}([${names.join(", ")}])`);
        break;
      }
      case "add_foreign_key":
        relate(p.table, p.column, p.refTable, p.refColumn, p.onDelete);
        break;
      case "drop_foreign_key": {
        const from = byTable(p.table);
        const to = byTable(p.refTable);
        const scalar = from && fieldFor(from, p.column)?.name;
        const lines = from && files.get(from.file)!;
        // The relation field names the scalar in `fields: [...]`.
        const relLine = lines
          ? from.fields.find(
              (f) =>
                f.line >= 0 &&
                !removed.get(from.file)?.has(f.line) &&
                new RegExp(`@relation\\([^)]*fields:\\s*\\[\\s*${scalar}\\s*\\]`).test(lines[f.line]!),
            )
          : undefined;
        if (!from || !lines || !relLine) {
          notes.push(`Could not find the relation for ${p.table}.${p.column} -> ${p.refTable} in schema.prisma; remove it by hand.`);
          break;
        }
        const text = lines[relLine.line]!;
        const label = text.match(/@relation\(\s*(?:name:\s*)?"([^"]+)"/)?.[1];
        remove(from.file, relLine.line);
        if (to) {
          const toLines = files.get(to.file)!;
          // The back-relation is the field of type From[] (or From?), with the same name when named.
          const backs = to.fields.filter((f) => {
            if (f.line < 0 || removed.get(to.file)?.has(f.line)) return false;
            const line = toLines[f.line]!;
            if (!new RegExp(`^\\s*\\w+\\s+${from.name}(\\[\\]|\\?)?(\\s|$)`).test(line)) return false;
            const theirs = line.match(/@relation\(\s*(?:name:\s*)?"([^"]+)"/)?.[1];
            return label ? theirs === label : !theirs;
          });
          if (backs.length === 1) remove(to.file, backs[0]!.line);
          else notes.push(`Remove the back-relation to ${from.name} from model ${to.name} by hand.`);
        }
        break;
      }
      case "backfill":
        break;
    }
  }

  for (const { model, fields, attrs } of added.values()) {
    const { typeCol, attrCol } = blockWidths(fields);
    const body = fields.map((f) => align(f, typeCol, attrCol)).join("\n");
    const ordered = [...attrs.filter((a) => !a.includes("@@map(")), ...attrs.filter((a) => a.includes("@@map("))];
    appended.push({ file: primary, text: `\nmodel ${model} {\n${body}${ordered.length ? `\n\n${ordered.join("\n")}` : ""}\n}\n` });
  }
  const out = new Map<string, string>();
  for (const [file, lines] of files) {
    const byLine = inserts.get(file);
    const next: string[] = [];
    const gone = removed.get(file);
    lines.forEach((line, i) => {
      for (const text of byLine?.get(i) ?? []) next.push(text);
      if (!gone?.has(i)) next.push(line);
    });
    let text = next.join("\n");
    for (const a of appended.filter((x) => x.file === file)) text = `${text.replace(/\n*$/, "\n")}${a.text}`;
    if (text !== sources.get(file)) out.set(file, text);
  }
  return { files: out, notes };
}
