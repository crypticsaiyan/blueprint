import path from "node:path";

import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
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

/** Finds `export const x = pgTable("name", { ... })` declarations. */
export function readDrizzleTables(file: SourceFile): DrizzleTable[] {
  const tables: DrizzleTable[] = [];
  for (const decl of file.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    if (init.getExpression().getText() !== "pgTable") continue;
    const name = stringArg(init);
    const shape = init.getArguments()[1];
    if (!name || !shape || !Node.isObjectLiteralExpression(shape)) continue;
    const columns: Record<string, string> = {};
    for (const prop of shape.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const column = stringArg(baseCall(prop.getInitializerOrThrow()));
      columns[prop.getName()] = column ?? prop.getName();
    }
    tables.push({ variable: decl.getName(), table: name, columns });
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

export async function analyzeTypescriptDrizzle(
  repoPath: string,
  snapshot: SchemaSnapshot,
): Promise<CodeAnalysis> {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true },
  });
  project.addSourceFilesAtPaths([
    `${repoPath}/**/*.{ts,tsx,mts,js,jsx,mjs}`,
    `!${repoPath}/**/node_modules/**`,
  ]);
  const files = project
    .getSourceFiles()
    .filter((f) => !IGNORED_DIRS.test(path.relative(repoPath, f.getFilePath())));

  const schemaFiles = files.filter((f) => f.getText().includes("pgTable("));
  const tables = schemaFiles.flatMap((file) =>
    readDrizzleTables(file).map((t) => ({ ...t, file })),
  );
  const schemaPaths = new Set(schemaFiles.map((f) => f.getFilePath()));
  const rel = (f: SourceFile) => path.relative(repoPath, f.getFilePath()).split(path.sep).join("/");

  const moduleFiles = files.filter(
    (f) => !schemaPaths.has(f.getFilePath()) && !NOT_A_MODULE.test(rel(f)),
  );
  const modulePaths = new Set(moduleFiles.map(rel));
  const usages: QueryUsage[] = [];
  const modules: CodeModule[] = [];

  for (const file of moduleFiles) {
    const modulePath = rel(file);
    // Table identifiers this file imports from a schema file.
    const imported = new Map<string, (typeof tables)[number]>();
    const imports: CodeModule["imports"] = [];
    for (const decl of file.getImportDeclarations()) {
      const target = decl.getModuleSpecifierSourceFile();
      if (!target) continue;
      if (schemaPaths.has(target.getFilePath())) {
        for (const named of decl.getNamedImports()) {
          const table = tables.find(
            (t) => t.variable === named.getName() && t.file === target,
          );
          if (table) imported.set(named.getAliasNode()?.getText() ?? named.getName(), table);
        }
      } else if (!decl.isTypeOnly() && modulePaths.has(rel(target))) {
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

  const schemaFile = schemaFiles[0] ? rel(schemaFiles[0]) : null;
  // Keep modules that touch the database or take part in module imports.
  const imported = new Set(modules.flatMap((m) => m.imports.map((i) => i.path)));
  const used = new Set(usages.map((u) => u.module));
  const shown = modules.filter(
    (m) => used.has(m.path) || m.imports.length > 0 || imported.has(m.path),
  );
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
    modules: shown.sort((a, b) => a.path.localeCompare(b.path)),
    usages: usages.sort((a, b) => a.module.localeCompare(b.module) || a.line - b.line),
    analyzedAt: new Date().toISOString(),
  };
}
