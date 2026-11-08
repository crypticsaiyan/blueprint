import {
  IndentationText,
  Node,
  Project,
  QuoteKind,
  type ObjectLiteralExpression,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";

import { activeItems, type ChangeItem, type ColumnSpec } from "../../../shared/changes.js";
import { readDrizzleTables } from "./typescript-drizzle.js";

const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

interface TableRef {
  variable: string;
  table: string;
  columns: Record<string, string>;
  decl?: VariableDeclaration;
}

class Codegen {
  pgCore = new Set<string>();
  needsSql = false;
  tables: TableRef[];

  constructor(private file: SourceFile) {
    this.tables = readDrizzleTables(file).map((t) => ({
      ...t,
      decl: file.getVariableDeclarationOrThrow(t.variable),
    }));
  }

  find(table: string) {
    return this.tables.find((t) => t.table === table);
  }

  shape(ref: TableRef): ObjectLiteralExpression {
    const init = ref.decl!.getInitializerOrThrow();
    if (!Node.isCallExpression(init)) throw new Error(`${ref.variable} is not a pgTable call`);
    const shape = init.getArguments()[1];
    if (!shape || !Node.isObjectLiteralExpression(shape)) throw new Error(`${ref.variable} has no column object`);
    return shape;
  }

  propFor(ref: TableRef, column: string) {
    const name = Object.entries(ref.columns).find(([, c]) => c === column)?.[0];
    if (!name) return undefined;
    const prop = this.shape(ref).getProperty(name);
    return prop && Node.isPropertyAssignment(prop) ? prop : undefined;
  }

  builder(column: ColumnSpec): string {
    const type = column.type.toLowerCase().trim();
    const n = JSON.stringify(column.name);
    const use = (fn: string, args = "") => {
      this.pgCore.add(fn);
      return `${fn}(${n}${args})`;
    };
    const varchar = type.match(/^(varchar|character varying)\((\d+)\)$/);
    if (varchar) return use("varchar", `, { length: ${varchar[2]} }`);
    if (type === "text" || type.startsWith("varchar") || type.startsWith("character varying")) return use("text");
    if (["integer", "int", "int4"].includes(type)) return use("integer");
    if (["bigint", "int8"].includes(type)) return use("bigint", `, { mode: "number" }`);
    if (["smallint", "int2"].includes(type)) return use("smallint");
    if (["boolean", "bool"].includes(type)) return use("boolean");
    if (["timestamptz", "timestamp with time zone"].includes(type)) return use("timestamp", `, { withTimezone: true }`);
    if (["timestamp", "timestamp without time zone"].includes(type)) return use("timestamp");
    if (type === "date") return use("date");
    if (type === "jsonb") return use("jsonb");
    if (type === "json") return use("json");
    if (type === "uuid") return use("uuid");
    if (type.startsWith("numeric") || type.startsWith("decimal")) return use("numeric");
    if (type === "real") return use("real");
    if (type === "double precision") return use("doublePrecision");
    if (type === "serial") return use("serial");
    if (type === "bigserial") return use("bigserial", `, { mode: "number" }`);
    throw new Error(`No Drizzle builder for type "${column.type}".`);
  }

  defaultCall(expr: string): string {
    const trimmed = expr.trim();
    if (/^now\(\)$/i.test(trimmed) || /^current_timestamp$/i.test(trimmed)) return ".defaultNow()";
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return `.default(${trimmed})`;
    if (/^(true|false)$/i.test(trimmed)) return `.default(${trimmed.toLowerCase()})`;
    const str = trimmed.match(/^'((?:[^']|'')*)'(::[a-z ]+)?$/i);
    if (str) return `.default(${JSON.stringify(str[1]!.replace(/''/g, "'"))})`;
    this.needsSql = true;
    return `.default(sql\`${trimmed.replace(/`/g, "\\`")}\`)`;
  }

  referenceCall(table: string, column: string, onDelete = "no action"): string {
    const target = this.find(table);
    if (!target) throw new Error(`Table ${table} is not in the Drizzle schema.`);
    const prop = Object.entries(target.columns).find(([, c]) => c === column)?.[0] ?? camel(column);
    const options = onDelete === "no action" ? "" : `, { onDelete: ${JSON.stringify(onDelete)} }`;
    return `.references(() => ${target.variable}.${prop}${options})`;
  }

  columnInit(column: ColumnSpec): string {
    let out = this.builder(column);
    if (column.primaryKey) out += ".primaryKey()";
    else if (!column.nullable) out += ".notNull()";
    if (column.default) out += this.defaultCall(column.default);
    if (column.references) {
      out += this.referenceCall(column.references.table, column.references.column, column.references.onDelete);
    }
    return out;
  }

  extraConfig(ref: TableRef, entry: string) {
    const init = ref.decl!.getInitializerOrThrow();
    if (!Node.isCallExpression(init)) return;
    const extra = init.getArguments()[2];
    if (!extra) {
      const shape = this.shape(ref);
      this.file.insertText(shape.getEnd(), `, (t) => [\n  ${entry},\n]`);
      return;
    }
    if (Node.isArrowFunction(extra)) {
      const body = extra.getBody();
      const array = Node.isArrayLiteralExpression(body)
        ? body
        : Node.isParenthesizedExpression(body) && Node.isArrayLiteralExpression(body.getExpression())
          ? body.getExpression()
          : undefined;
      if (array && Node.isArrayLiteralExpression(array)) {
        array.addElement(entry);
        return;
      }
    }
    throw new Error(`Cannot add an index to ${ref.variable}: unsupported extra config shape.`);
  }

  /** Applies one item; text edits invalidate nodes, so callers re-parse after each. */
  apply(item: ChangeItem) {
    const p = item.payload;
    switch (p.kind) {
      case "create_table": {
        if (this.find(p.table)) return;
        this.pgCore.add("pgTable");
        const variable = camel(p.table);
        const ref: TableRef = { variable, table: p.table, columns: Object.fromEntries(p.columns.map((c) => [camel(c.name), c.name])) };
        this.tables.push(ref);
        void ref;
        const body = p.columns.map((c) => `  ${camel(c.name)}: ${this.columnInit(c)},`).join("\n");
        const firstTable = this.tables[0]?.decl?.getVariableStatementOrThrow();
        const pos = firstTable ? firstTable.getFullStart() : this.file.getEnd();
        this.file.insertText(pos, `\n\nexport const ${variable} = pgTable(${JSON.stringify(p.table)}, {\n${body}\n});`);
        return;
      }
      case "add_column": {
        const ref = this.find(p.table);
        if (!ref) throw new Error(`Table ${p.table} is not in the Drizzle schema.`);
        if (this.propFor(ref, p.column.name)) return;
        const shape = this.shape(ref);
        const props = shape.getProperties();
        const last = props[props.length - 1];
        const line = `${camel(p.column.name)}: ${this.columnInit(p.column)},`;
        if (!last) {
          this.file.insertText(shape.getStart() + 1, `\n  ${line}\n`);
          return;
        }
        const indent = last.getIndentationText();
        const full = this.file.getFullText();
        const comma = full[last.getEnd()] === ",";
        this.file.insertText(last.getEnd() + (comma ? 1 : 0), `${comma ? "" : ","}\n${indent}${line}`);
        return;
      }
      case "set_not_null": {
        const ref = this.find(p.table);
        const prop = ref && this.propFor(ref, p.column);
        if (!prop) throw new Error(`Column ${p.table}.${p.column} is not in the Drizzle schema.`);
        const text = prop.getInitializerOrThrow().getText();
        if (!text.includes(".notNull()")) prop.setInitializer(insertAfterBuilder(text, ".notNull()"));
        return;
      }
      case "add_foreign_key": {
        const ref = this.find(p.table);
        const prop = ref && this.propFor(ref, p.column);
        if (!prop) throw new Error(`Column ${p.table}.${p.column} is not in the Drizzle schema.`);
        const text = prop.getInitializerOrThrow().getText();
        if (!text.includes(".references(")) prop.setInitializer(text + this.referenceCall(p.refTable, p.refColumn, p.onDelete));
        return;
      }
      case "drop_foreign_key": {
        const ref = this.find(p.table);
        const prop = ref && this.propFor(ref, p.column);
        if (prop) prop.setInitializer(removeCall(prop.getInitializerOrThrow().getText(), ".references("));
        return;
      }
      case "add_unique": {
        const ref = this.find(p.table);
        if (!ref) throw new Error(`Table ${p.table} is not in the Drizzle schema.`);
        this.pgCore.add("uniqueIndex");
        const cols = p.columns.map((c) => {
          const prop = Object.entries(ref.columns).find(([, col]) => col === c)?.[0] ?? camel(c);
          if (!p.caseInsensitive) return `t.${prop}`;
          this.needsSql = true;
          return `sql\`lower(\${t.${prop}})\``;
        });
        const name = `${p.table}_${p.columns.join("_")}_${p.caseInsensitive ? "lower_" : ""}key`.slice(0, 63);
        this.extraConfig(ref, `uniqueIndex(${JSON.stringify(name)}).on(${cols.join(", ")})`);
        return;
      }
      case "add_index": {
        const ref = this.find(p.table);
        if (!ref) throw new Error(`Table ${p.table} is not in the Drizzle schema.`);
        this.pgCore.add("index");
        const cols = p.columns.map((c) => `t.${Object.entries(ref.columns).find(([, col]) => col === c)?.[0] ?? camel(c)}`);
        this.extraConfig(ref, `index(${JSON.stringify(`${p.table}_${p.columns.join("_")}_idx`.slice(0, 63))}).on(${cols.join(", ")})`);
        return;
      }
      case "backfill":
        return;
    }
  }

  fixImports() {
    const pgImport = this.file.getImportDeclaration((d) => d.getModuleSpecifierValue() === "drizzle-orm/pg-core");
    const have = new Set(pgImport?.getNamedImports().map((n) => n.getName()) ?? []);
    const missing = [...this.pgCore].filter((n) => !have.has(n)).sort();
    const named = pgImport?.getNamedImports() ?? [];
    const last = named[named.length - 1];
    if (pgImport && last && missing.length) {
      // Text insert keeps the file's own import layout (one name per line or not).
      const full = this.file.getFullText();
      const multiline = pgImport.getText().includes("\n");
      const comma = full[last.getEnd()] === ",";
      const sep = multiline ? `\n${last.getIndentationText()}` : " ";
      const text = missing.map((n) => `${sep}${n}`).join(",");
      this.file.insertText(last.getEnd() + (comma ? 1 : 0), `${comma ? "" : ","}${text}${comma ? "," : ""}`);
    } else if (pgImport && !last && missing.length) {
      pgImport.addNamedImports(missing);
    } else if (!pgImport && missing.length) {
      this.file.insertImportDeclaration(0, { moduleSpecifier: "drizzle-orm/pg-core", namedImports: missing });
    }
    if (this.needsSql) {
      const orm = this.file.getImportDeclaration((d) => d.getModuleSpecifierValue() === "drizzle-orm");
      if (!orm) this.file.insertImportDeclaration(0, { moduleSpecifier: "drizzle-orm", namedImports: ["sql"] });
      else if (!orm.getNamedImports().some((n) => n.getName() === "sql")) orm.addNamedImport("sql");
    }
  }
}

/** `text("x").references(...)` → insert after the builder call, before chained calls. */
function insertAfterBuilder(text: string, call: string) {
  const close = matchingParen(text, text.indexOf("("));
  return close < 0 ? text + call : text.slice(0, close + 1) + call + text.slice(close + 1);
}

function matchingParen(text: string, open: number) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function removeCall(text: string, marker: string) {
  const start = text.indexOf(marker);
  if (start < 0) return text;
  const close = matchingParen(text, start + marker.length - 1);
  return close < 0 ? text : text.slice(0, start) + text.slice(close + 1);
}

/**
 * Applies a changeset to a Drizzle schema file, so the ORM matches the
 * migrated database. Deterministic: same baseline + items, same output.
 */
export function generateDrizzleSchema(source: string, items: ChangeItem[]): string {
  const project = new Project({
    useInMemoryFileSystem: true,
    manipulationSettings: { indentationText: IndentationText.TwoSpaces, quoteKind: QuoteKind.Double },
  });
  const ordered = [...activeItems(items)].sort((a, b) => a.position - b.position);
  // Tables first, so later items can reference them.
  const sequence = [
    ...ordered.filter((i) => i.payload.kind === "create_table"),
    ...ordered.filter((i) => i.payload.kind !== "create_table"),
  ];
  const pgCore = new Set<string>();
  let needsSql = false;
  let text = source;
  for (const item of sequence) {
    const file = project.createSourceFile("schema.ts", text, { overwrite: true });
    const gen = new Codegen(file);
    gen.apply(item);
    gen.pgCore.forEach((n) => pgCore.add(n));
    needsSql ||= gen.needsSql;
    text = file.getFullText();
  }
  const file = project.createSourceFile("schema.ts", text, { overwrite: true });
  const gen = new Codegen(file);
  gen.pgCore = pgCore;
  gen.needsSql = needsSql;
  gen.fixImports();
  return file.getFullText();
}
