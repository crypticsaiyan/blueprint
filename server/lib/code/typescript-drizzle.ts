import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type CallExpression,
  type ImportDeclaration,
  type SourceFile,
} from "ts-morph";

import type {
  CodeAnalysis,
  CodeModule,
  QueryUsage,
  UsageOperation,
} from "../../../shared/code-types.js";
import type { SchemaSnapshot } from "../../../shared/schema-types.js";

const IGNORED_DIRS = /(^|\/)(node_modules|dist|build|coverage|\.next|\.git|\.output|data)(\/|$)/;
const SOURCE = /\.(ts|tsx|mts|js|jsx|mjs)$/;
// Past this many files, parsing every one takes gigabytes, so only files that
// could hold tables, queries or re-exports of them are parsed.
const LARGE_REPO = 3000;
const MAY_TOUCH_DB = /drizzle|pgTable|\bdb\b|\btx\b|\.query\.|export\s*\*\s*from|export\s*\{[^}]*\}\s*from/;

async function sourcePaths(dir: string, out: string[]) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !IGNORED_DIRS.test(entry.name)) await sourcePaths(full, out);
    } else if (SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
}

/** The repo's source files in a ts-morph project, minus generated and bundled ones. */
async function loadProject(repoPath: string) {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true },
  });
  const paths: string[] = [];
  await sourcePaths(repoPath, paths);
  const large = paths.length > LARGE_REPO;
  for (const file of paths) {
    // Minified bundles and generated clients are not the repo's own queries.
    if ((await stat(file)).size > 1024 * 1024) continue;
    const text = await readFile(file, "utf8");
    if (large && !MAY_TOUCH_DB.test(text)) continue;
    project.createSourceFile(file, text, { overwrite: true });
  }
  return { project, large };
}

const NOT_A_MODULE = /(\.test\.|\.spec\.|(^|\/)(tests?|__tests__|scripts)\/|\.config\.|\.d\.ts$)/;

const OPERATIONS: Record<string, UsageOperation> = {
  from: "select",
  innerJoin: "join",
  leftJoin: "join",
  rightJoin: "join",
  fullJoin: "join",
  insert: "insert",
  update: "update",
  delete: "delete",
};

export interface DrizzleTable {
  variable: string;
  table: string;
  /** property name → SQL column name */
  columns: Record<string, string>;
}

function baseCall(node: Node): CallExpression | undefined {
  // text("owner_id").notNull().references(...) → text("owner_id")
  let current: Node | undefined = node;
  while (current && Node.isCallExpression(current)) {
    const callee = current.getExpression();
    if (Node.isPropertyAccessExpression(callee) && Node.isCallExpression(callee.getExpression())) {
      current = callee.getExpression();
    } else {
      return current;
    }
  }
  return undefined;
}

function stringArg(call: CallExpression | undefined): string | null {
  const arg = call?.getArguments()[0];
  return arg && Node.isStringLiteral(arg) ? arg.getLiteralValue() : null;
}

/**
 * The functions that define tables, by how calls spell them, each with the
 * SQL name it gives a table: `pgTable` keeps it, a `pgTableCreator` adds its
 * prefix, and `mySchema.table` (from `pgSchema("s")`) puts it in schema s.
 */
export type TableBuilders = ReadonlyMap<string, (name: string) => string>;
export const DEFAULT_BUILDERS: TableBuilders = new Map([["pgTable", (n: string) => n]]);

/** Finds `pgTableCreator` and `pgSchema` declarations across the given files. */
export function drizzleBuilders(files: SourceFile[], knownTables: readonly string[] = []): TableBuilders {
  const builders = new Map(DEFAULT_BUILDERS);
  const known = new Set(knownTables);
  for (const file of files) {
    const text = file.getText();
    if (!text.includes("pgTableCreator") && !text.includes("pgSchema")) continue;
    for (const decl of file.getVariableDeclarations()) {
      const init = decl.getInitializer();
      if (!init || !Node.isCallExpression(init)) continue;
      const callee = init.getExpression().getText().replace(/^\w+\./, "");
      const arg = init.getArguments()[0];
      if (callee === "pgTableCreator") {
        // `(name) => \`app_${name}\``: read the prefix and suffix off the template.
        const m = arg?.getText().match(/^\(?\s*(\w+)\s*(?::\s*\w+)?\)?\s*=>\s*`([^`$]*)\$\{\s*\1\s*\}([^`$]*)`$/);
        builders.set(
          decl.getName(),
          m
            ? (n: string) => `${m[2]}${n}${m[3]}`
            : // Unreadable naming: match the database's one table ending in _name.
              (n: string) => {
                if (known.has(n)) return n;
                const hits = knownTables.filter((t) => t.endsWith(`_${n}`));
                return hits.length === 1 ? hits[0]! : n;
              },
        );
      } else if (callee === "pgSchema" && arg && Node.isStringLiteral(arg)) {
        const schema = arg.getLiteralValue();
        builders.set(`${decl.getName()}.table`, (n: string) => (schema === "public" ? n : `${schema}.${n}`));
      }
    }
  }
  return builders;
}

/** How a call spells its callee, as `TableBuilders` keys it. */
function calleeKey(call: CallExpression): string[] {
  const expr = call.getExpression();
  if (Node.isIdentifier(expr)) return [expr.getText()];
  if (Node.isPropertyAccessExpression(expr) && !Node.isCallExpression(expr.getExpression())) {
    // `core.pgTable` (namespace import) or `mySchema.table`.
    return [expr.getText(), expr.getName()];
  }
  return [];
}

/**
 * The table-defining call inside a table initializer, looking through
 * chained calls such as `pgTable(...).enableRLS()`.
 */
export function tableCall(init: Node | undefined, builders: TableBuilders = DEFAULT_BUILDERS): CallExpression | undefined {
  let node = init;
  while (node && Node.isCallExpression(node)) {
    const call: CallExpression = node;
    if (calleeKey(call).some((k) => builders.has(k))) return call;
    const expr = call.getExpression();
    node = Node.isPropertyAccessExpression(expr) ? expr.getExpression() : undefined;
  }
  return undefined;
}

/** The SQL table name a table call defines. */
function sqlTableName(call: CallExpression, name: string, builders: TableBuilders) {
  const key = calleeKey(call).find((k) => builders.has(k));
  return key ? builders.get(key)!(name) : name;
}

/** Finds `export const x = pgTable("name", { ... })` declarations. */
export function readDrizzleTables(file: SourceFile, builders: TableBuilders = DEFAULT_BUILDERS): (DrizzleTable & { builder: string })[] {
  const tables: (DrizzleTable & { builder: string })[] = [];
  for (const decl of file.getVariableDeclarations()) {
    const init = tableCall(decl.getInitializer(), builders);
    if (!init) continue;
    const name = stringArg(init);
    const shape = init.getArguments()[1];
    if (!name || !shape || !Node.isObjectLiteralExpression(shape)) continue;
    const columns: Record<string, string> = {};
    for (const prop of shape.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const column = stringArg(baseCall(prop.getInitializerOrThrow()));
      columns[prop.getName()] = column ?? prop.getName();
    }
    tables.push({ variable: decl.getName(), table: sqlTableName(init, name, builders), columns, builder: init.getExpression().getText() });
  }
  return tables;
}

/**
 * Property names written by `.values(x)` / `.set(x)`: keys of an object
 * literal (and of spread objects), or of the inline type of a parameter.
 */
function writtenKeys(arg: Node | undefined, depth = 0): string[] {
  if (!arg || depth > 3) return [];
  if (Node.isObjectLiteralExpression(arg)) {
    return arg.getProperties().flatMap((prop) => {
      if (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop)) return [prop.getName()];
      if (Node.isSpreadAssignment(prop)) return writtenKeys(prop.getExpression(), depth + 1);
      return [];
    });
  }
  if (Node.isIdentifier(arg)) {
    for (const decl of arg.getSymbol()?.getDeclarations() ?? []) {
      if (Node.isParameterDeclaration(decl) || Node.isVariableDeclaration(decl)) {
        const type = decl.getTypeNode();
        if (type && Node.isTypeLiteral(type)) return type.getProperties().map((p) => p.getName());
        const init = Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
        if (init) return writtenKeys(init, depth + 1);
      }
    }
  }
  return [];
}

function enclosingFunction(node: Node): string {
  for (const ancestor of node.getAncestors()) {
    if (Node.isFunctionDeclaration(ancestor) || Node.isMethodDeclaration(ancestor)) {
      return ancestor.getName() ?? "(anonymous)";
    }
    if (Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor)) {
      const parent = ancestor.getParent();
      if (Node.isVariableDeclaration(parent)) return parent.getName();
      if (Node.isPropertyAssignment(parent)) return parent.getName();
    }
  }
  return "(module)";
}

function enclosingStatement(node: Node): Node {
  return (
    node.getFirstAncestor(
      (a) =>
        Node.isVariableStatement(a) ||
        Node.isReturnStatement(a) ||
        Node.isExpressionStatement(a),
    ) ?? node
  );
}

function snippetOf(node: Node) {
  const text = node.getText().replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

const SQL_KEYWORDS = new Set([
  "where", "join", "on", "group", "order", "left", "right", "inner", "outer",
  "full", "cross", "limit", "set", "values", "using", "as", "select", "returning",
]);

function rawUsages(text: string, snapshot: SchemaSnapshot) {
  const found: { table: string; columns: string[]; write: boolean }[] = [];
  const pattern = /\b(from|join|into|update)\s+"?([a-z_][a-z0-9_]*)"?(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;
  for (const match of text.matchAll(pattern)) {
    const keyword = match[1]!.toLowerCase();
    const tableName = match[2]!;
    const table = snapshot.tables.find((t) => t.name === tableName);
    if (!table) continue;
    const alias =
      match[3] && !SQL_KEYWORDS.has(match[3].toLowerCase()) ? match[3] : tableName;
    const columns = table.columns
      .map((c) => c.name)
      .filter((c) => new RegExp(`\\b${alias}\\.${c}\\b`).test(text));
    found.push({ table: tableName, columns, write: keyword === "into" || keyword === "update" });
  }
  return found;
}

/**
 * Resolves imports the way the repo's own TypeScript does: path aliases such
 * as `@/lib/db/schema` come from the nearest tsconfig (with `extends`), so
 * each package of a monorepo uses its own aliases.
 */
function aliasResolver(repoPath: string, project: Project) {
  const configs = new Map<string, ts.CompilerOptions | null>();
  // Only compiler options are needed; skip walking the file system for `include`.
  const host: ts.ParseConfigHost = { ...ts.sys, readDirectory: () => [] };
  const optionsFor = (dir: string): ts.CompilerOptions | null => {
    if (configs.has(dir)) return configs.get(dir)!;
    let options: ts.CompilerOptions | null = null;
    const file = path.join(dir, "tsconfig.json");
    if (existsSync(file)) {
      const read = ts.readConfigFile(file, ts.sys.readFile);
      if (!read.error) options = ts.parseJsonConfigFileContent(read.config, host, dir, undefined, file).options;
    } else if (dir !== repoPath && dir.startsWith(repoPath)) {
      options = optionsFor(path.dirname(dir));
    }
    configs.set(dir, options);
    return options;
  };
  // Workspace packages (`@acme/db/schema`) resolve through node_modules links
  // that an uninstalled clone lacks, so read their package.json exports.
  const packages = new Map<string, { dir: string; exports: unknown }>();
  for (const file of project.getSourceFiles()) {
    let dir = path.dirname(file.getFilePath());
    while (dir.startsWith(repoPath) && !packages.has(dir)) {
      const pkgFile = path.join(dir, "package.json");
      if (existsSync(pkgFile)) {
        try {
          const pkg = JSON.parse(ts.sys.readFile(pkgFile) ?? "{}") as { name?: string; exports?: unknown };
          if (pkg.name) packages.set(pkg.name, { dir, exports: pkg.exports });
        } catch {
          // Not JSON: skip.
        }
        break;
      }
      dir = path.dirname(dir);
    }
  }
  const pick = (target: unknown): string | null => {
    if (typeof target === "string") return target;
    if (target && typeof target === "object") {
      const t = target as Record<string, unknown>;
      for (const key of ["types", "import", "default", "require", "node"]) {
        const found = pick(t[key]);
        if (found) return found;
      }
    }
    return null;
  };
  const fromWorkspace = (spec: string): SourceFile | undefined => {
    const name = [...packages.keys()].filter((n) => spec === n || spec.startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0];
    if (!name) return undefined;
    const { dir, exports } = packages.get(name)!;
    const sub = `.${spec.slice(name.length)}`;
    let rel: string | null = null;
    if (exports && typeof exports === "object" && !Array.isArray(exports)) {
      const map = exports as Record<string, unknown>;
      const keys = Object.keys(map);
      if (keys.some((k) => k.startsWith("."))) {
        if (map[sub] !== undefined) rel = pick(map[sub]);
        else {
          for (const key of keys.filter((k) => k.includes("*"))) {
            const [head, tail] = key.split("*") as [string, string];
            if (sub.startsWith(head) && sub.endsWith(tail)) {
              const star = sub.slice(head.length, sub.length - tail.length);
              rel = pick(map[key])?.split("*").join(star) ?? null;
              break;
            }
          }
        }
      } else if (sub === ".") rel = pick(exports);
    } else if (sub === "." && typeof exports === "string") rel = exports;
    const base = path.join(dir, rel ?? sub);
    for (const candidate of [base, ...[".ts", ".tsx", ".mts", ".js", "/index.ts", "/index.tsx", "/index.js"].map((ext) => base.replace(/\.(js|mjs)$/, "") + ext)]) {
      const found = project.getSourceFile(candidate);
      if (found) return found;
    }
    return undefined;
  };
  return (decl: ImportDeclaration): SourceFile | undefined => {
    const direct = decl.getModuleSpecifierSourceFile();
    if (direct) return direct;
    const spec = decl.getModuleSpecifierValue();
    if (spec.startsWith(".")) return undefined;
    const from = decl.getSourceFile().getFilePath();
    const options = optionsFor(path.dirname(from));
    if (options) {
      const resolved = ts.resolveModuleName(spec, from, { ...options, allowJs: true }, ts.sys).resolvedModule;
      const file = resolved && project.getSourceFile(resolved.resolvedFileName);
      if (file) return file;
    }
    return fromWorkspace(spec);
  };
}

export async function analyzeTypescriptDrizzle(
  repoPath: string,
  snapshot: SchemaSnapshot,
): Promise<CodeAnalysis> {
  const { project, large } = await loadProject(repoPath);
  const files = project.getSourceFiles();

  // `pgTableCreator` and `pgSchema` define tables too, under other names.
  const builders = drizzleBuilders(files, snapshot.tables.map((t) => t.name));
  const schemaFiles = files.filter((f) => [...builders.keys()].some((b) => f.getText().includes(`${b}(`)));
  const tables = schemaFiles.flatMap((file) => readDrizzleTables(file, builders).map((t) => ({ ...t, file })));
  const schemaPaths = new Set(schemaFiles.map((f) => f.getFilePath()));
  const rel = (f: SourceFile) => path.relative(repoPath, f.getFilePath()).split(path.sep).join("/");

  const moduleFiles = files.filter(
    (f) => !schemaPaths.has(f.getFilePath()) && !NOT_A_MODULE.test(rel(f)),
  );
  const modulePaths = new Set(moduleFiles.map(rel));
  const resolveImport = aliasResolver(repoPath, project);
  // The table a named import refers to, following barrel re-exports
  // (`export * from "./cards"`) to the file that declares it.
  const exportCache = new Map<SourceFile, ReadonlyMap<string, Node[]>>();
  const tableExport = (target: SourceFile, name: string) => {
    if (schemaPaths.has(target.getFilePath())) {
      const own = tables.find((t) => t.variable === name && t.file === target);
      if (own) return own;
    }
    let exported = exportCache.get(target);
    if (!exported) {
      try {
        exported = target.getExportedDeclarations();
      } catch {
        exported = new Map();
      }
      exportCache.set(target, exported);
    }
    for (const decl of exported.get(name) ?? []) {
      if (!Node.isVariableDeclaration(decl)) continue;
      const file = decl.getSourceFile();
      const table = tables.find((t) => t.variable === decl.getName() && t.file === file);
      if (table) return table;
    }
    return undefined;
  };
  const usages: QueryUsage[] = [];
  const modules: CodeModule[] = [];

  for (const file of moduleFiles) {
    const modulePath = rel(file);
    // Table identifiers this file imports from a schema file.
    const imported = new Map<string, (typeof tables)[number]>();
    const imports: CodeModule["imports"] = [];
    for (const decl of file.getImportDeclarations()) {
      const target = resolveImport(decl);
      if (!target) continue;
      let tablesFound = false;
      for (const named of decl.getNamedImports()) {
        const table = tableExport(target, named.getName());
        if (table) {
          tablesFound = true;
          imported.set(named.getAliasNode()?.getText() ?? named.getName(), table);
        }
      }
      if (!tablesFound && !decl.isTypeOnly() && modulePaths.has(rel(target))) {
        imports.push({ path: rel(target), line: decl.getStartLineNumber() });
      }
    }
    modules.push({ path: modulePath, label: modulePath, imports });

    const seen = new Set<string>();
    const add = (usage: Omit<QueryUsage, "id" | "module">) => {
      const key = `${usage.function}:${usage.table}:${usage.operation}:${usage.line}`;
      if (seen.has(key)) return;
      seen.add(key);
      usages.push({ ...usage, id: `${modulePath}:${usage.line}:${usage.table}:${usage.operation}`, module: modulePath });
    };

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const operation = OPERATIONS[callee.getName()];
      const arg = call.getArguments()[0];
      if (!operation || !arg || !Node.isIdentifier(arg)) continue;
      const table = imported.get(arg.getText());
      if (!table) continue;

      const statement = enclosingStatement(call);
      const columns = new Set<string>();
      for (const access of statement.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (access.getExpression().getText() === arg.getText()) {
          const column = table.columns[access.getName()];
          if (column) columns.add(column);
        }
      }
      if (operation === "insert" || operation === "update") {
        // Keys of .values({...}) / .set({...}) on this chain name written columns.
        for (const inner of statement.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const name = inner.getExpression();
          if (!Node.isPropertyAccessExpression(name)) continue;
          if (!["values", "set"].includes(name.getName())) continue;
          for (const name of writtenKeys(inner.getArguments()[0])) {
            const column = table.columns[name];
            if (column) columns.add(column);
          }
        }
      }
      add({
        function: enclosingFunction(call),
        line: arg.getStartLineNumber(),
        table: table.table,
        columns: [...columns].sort(),
        kind: ["insert", "update", "delete"].includes(operation) ? "write" : "read",
        operation,
        snippet: snippetOf(statement),
        approximate: false,
      });
    }

    // Relational queries: db.query.<table>.findFirst / findMany.
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || !["findFirst", "findMany"].includes(callee.getName())) continue;
      const tableAccess = callee.getExpression();
      if (!Node.isPropertyAccessExpression(tableAccess)) continue;
      const queryAccess = tableAccess.getExpression();
      if (!Node.isPropertyAccessExpression(queryAccess) || queryAccess.getName() !== "query") continue;
      const table = tables.find((t) => t.variable === tableAccess.getName());
      if (!table) continue;
      const columns = new Set<string>();
      const statement = enclosingStatement(call);
      for (const access of statement.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const owner = imported.get(access.getExpression().getText());
        if (owner === table && table.columns[access.getName()]) columns.add(table.columns[access.getName()]!);
      }
      const options = call.getArguments()[0];
      if (options && Node.isObjectLiteralExpression(options)) {
        const picked = options.getProperty("columns");
        const literal = picked && Node.isPropertyAssignment(picked) ? picked.getInitializer() : undefined;
        for (const name of writtenKeys(literal)) if (table.columns[name]) columns.add(table.columns[name]!);
      }
      add({
        function: enclosingFunction(call),
        line: tableAccess.getNameNode().getStartLineNumber(),
        table: table.table,
        columns: [...columns].sort(),
        kind: "read",
        operation: "select",
        snippet: snippetOf(statement),
        approximate: false,
      });
    }

    for (const tagged of file.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
      if (tagged.getTag().getText() !== "sql") continue;
      const template = tagged.getTemplate();
      const text = Node.isNoSubstitutionTemplateLiteral(template)
        ? template.getLiteralText()
        : [template.getHead().getLiteralText(), ...template.getTemplateSpans().map((s) => s.getLiteral().getLiteralText())].join(" ? ");
      for (const found of rawUsages(text, snapshot)) {
        add({
          function: enclosingFunction(tagged),
          line: tagged.getStartLineNumber(),
          table: found.table,
          columns: found.columns,
          kind: found.write ? "write" : "read",
          operation: "raw",
          snippet: snippetOf(tagged),
          approximate: true,
        });
      }
    }
  }

  // The file holding the most tables is the main one (often there is one).
  const tableCount = (f: SourceFile) => tables.filter((t) => t.file === f).length;
  const main = [...schemaFiles].sort((a, b) => tableCount(b) - tableCount(a))[0];
  const schemaFile = main ? rel(main) : null;
  // Keep modules that touch the database or take part in module imports.
  const imported = new Set(modules.flatMap((m) => m.imports.map((i) => i.path)));
  const used = new Set(usages.map((u) => u.module));
  // In a large repo the map keeps only modules that query the database.
  const shown = modules.filter(
    (m) => used.has(m.path) || (!large && (m.imports.length > 0 || imported.has(m.path))),
  );
  if (large) for (const m of shown) m.imports = m.imports.filter((i) => used.has(i.path));
  // Labels drop the folder every module shares, e.g. "src/modules/".
  const dirs = shown.map((m) => m.path.split("/").slice(0, -1));
  let common = dirs[0] ?? [];
  for (const dir of dirs) {
    let i = 0;
    while (i < common.length && dir[i] === common[i]) i++;
    common = common.slice(0, i);
  }
  for (const module of shown) module.label = module.path.split("/").slice(common.length).join("/");
  return {
    adapter: "typescript-drizzle",
    approximate: false,
    schemaFile,
    schemaFiles: schemaFiles.filter((f) => tableCount(f) > 0).map(rel).sort(),
    modules: shown.sort((a, b) => a.path.localeCompare(b.path)),
    usages: usages.sort((a, b) => a.module.localeCompare(b.module) || a.line - b.line),
    analyzedAt: new Date().toISOString(),
  };
}
