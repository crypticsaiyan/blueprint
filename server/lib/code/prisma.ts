import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CodeAnalysis, QueryUsage, UsageOperation } from "../../../shared/code-types.js";
import type { SchemaSnapshot } from "../../../shared/schema-types.js";
import { argumentText, enclosingFunction, scanRepo, walk } from "./pattern-scan.js";

// Prisma repos: queries are `prisma.<model>.<method>(...)` calls. The models
// come from schema.prisma, so a call names its table exactly, and the keys in
// its arguments name the columns. Calls are found by pattern, not by type
// checking, so results stay labeled approximate.

const METHODS: Record<string, UsageOperation> = {
  findMany: "select",
  findFirst: "select",
  findFirstOrThrow: "select",
  findUnique: "select",
  findUniqueOrThrow: "select",
  count: "select",
  aggregate: "select",
  groupBy: "select",
  create: "insert",
  createMany: "insert",
  createManyAndReturn: "insert",
  update: "update",
  updateMany: "update",
  updateManyAndReturn: "update",
  // An upsert inserts when the row is new, so it must set required columns.
  upsert: "insert",
  delete: "delete",
  deleteMany: "delete",
};

interface Model {
  name: string;
  table: string;
  /** Prisma field name to database column, scalar fields only. */
  columns: Map<string, string>;
}

/** schema.prisma, or every .prisma file of a split schema folder. */
async function schemaFiles(repoPath: string) {
  const files: string[] = [];
  await walk(repoPath, (name) => name.endsWith(".prisma"), files, 6);
  return files;
}

/** Models from Prisma schema text, with @@map and @map resolved. */
export function parseModels(text: string): Model[] {
  const models: Model[] = [];
  const enums = new Set([...text.matchAll(/^\s*enum\s+(\w+)\s*\{/gm)].map((m) => m[1]!));
  const names = new Set([...text.matchAll(/^\s*model\s+(\w+)\s*\{/gm)].map((m) => m[1]!));
  for (const match of text.matchAll(/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
    const [, name, body] = match as unknown as [string, string, string];
    const table = body.match(/@@map\(\s*(?:name:\s*)?"([^"]+)"/)?.[1] ?? name;
    const columns = new Map<string, string>();
    for (const line of body.split("\n")) {
      const field = line.match(/^\s*(\w+)\s+(\w+)(\[\])?\??/);
      if (!field || line.trim().startsWith("//") || line.trim().startsWith("@@")) continue;
      const [, fieldName, type] = field as unknown as [string, string, string];
      // Relation fields hold no column; their foreign key is a scalar field.
      if (names.has(type) && !enums.has(type)) continue;
      columns.set(fieldName, line.match(/@map\(\s*(?:name:\s*)?"([^"]+)"/)?.[1] ?? fieldName);
    }
    models.push({ name, table, columns });
  }
  return models;
}

/** True when the repo is a Prisma app with a schema Blueprint can read. */
export async function hasPrismaSchema(repoPath: string) {
  for (const file of await schemaFiles(repoPath)) {
    if (/^\s*model\s+\w+\s*\{/m.test(await readFile(file, "utf8"))) return true;
  }
  return false;
}

export async function analyzePrisma(repoPath: string, snapshot: SchemaSnapshot): Promise<CodeAnalysis> {
  // Split schemas relate models across files, so the files parse as one text.
  const paths = await schemaFiles(repoPath);
  const texts = await Promise.all(paths.map((file) => readFile(file, "utf8")));
  const models = parseModels(texts.join("\n"));
  const tables = new Set(snapshot.tables.map((t) => t.name));
  // A model whose table the database does not have (another schema, a view) is left out.
  const byDelegate = new Map(
    models.filter((m) => tables.has(m.table)).map((m) => [m.name[0]!.toLowerCase() + m.name.slice(1), m]),
  );
  if (!byDelegate.size) {
    return { adapter: "prisma", approximate: true, schemaFile: null, modules: [], usages: [], analyzedAt: new Date().toISOString() };
  }
  const call = new RegExp(`\\.\\s*(${[...byDelegate.keys()].join("|")})\\s*\\.\\s*(${Object.keys(METHODS).join("|")})\\s*(?:<[^>]*>)?\\s*\\(`, "g");

  const { modules, usages } = await scanRepo(repoPath, new RegExp(call.source), (rel, lines) => {
    const found: QueryUsage[] = [];
    lines.forEach((line, index) => {
      for (const m of line.matchAll(call)) {
        const model = byDelegate.get(m[1]!)!;
        const operation = METHODS[m[2]!]!;
        const args = argumentText(lines, index, m.index! + m[0].length - 1);
        const columns = [...model.columns]
          // `field: value`, or the shorthand `{ field }`.
          .filter(([field]) => new RegExp(`\\b${field}\\s*:|[{,]\\s*${field}\\s*[,}]`).test(args))
          .map(([, column]) => column);
        found.push({
          id: `${rel}:${index + 1}:${model.table}:${operation}:${m.index}`,
          module: rel,
          function: enclosingFunction(lines, index),
          line: index + 1,
          table: model.table,
          columns,
          kind: operation === "select" ? "read" : "write",
          operation,
          snippet: line.trim().slice(0, 180),
          approximate: true,
        });
      }
    });
    return found;
  });
  // The .prisma files that define this database's models; codegen edits them.
  const kept = [...byDelegate.values()].map((m) => m.name);
  const files = paths
    .filter((_, i) => kept.some((name) => new RegExp(`^\\s*model\\s+${name}\\s*\\{`, "m").test(texts[i]!)))
    .map((file) => path.relative(repoPath, file).split(path.sep).join("/"))
    .sort();
  return { adapter: "prisma", approximate: true, schemaFile: null, schemaFiles: files, modules, usages, analyzedAt: new Date().toISOString() };
}
