import { defineAction, fail } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  cloneRepo,
  DEMO_REPO_PATH,
  parseGithubUrl,
  removeCheckout,
} from "../server/lib/import.js";
import { describeSource, findSchemaSource, materializeSource, type SchemaSource } from "../server/lib/schema-source.js";
import { introspect } from "../server/lib/introspect.js";
import { analyzeCode } from "../server/lib/code/index.js";
import { layoutModules, layoutTables, nowIso } from "../server/lib/projects.js";
import { loadDump, loadReport, type LoadReport } from "../server/lib/sandbox.js";

export default defineAction({
  description:
    "Import a codebase and its sample database into Blueprint and build the map. source \"demo\" imports the bundled Tallyhub demo repo; source \"github\" clones repoUrl and loads its SQL dump. Returns the new project id.",
  schema: z.object({
    source: z
      .enum(["demo", "github"])
      .default("demo")
      .describe('"demo" for the bundled Tallyhub repo, "github" to clone repoUrl; defaults to "demo"'),
    repoUrl: z
      .string()
      .optional()
      .describe("GitHub URL, e.g. https://github.com/owner/repo; required when source is github"),
    dumpPath: z
      .string()
      .optional()
      .describe(
        "Path inside the repo to a SQL dump or a folder of SQL migrations; found automatically when omitted",
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    tables: z.number(),
    rows: z.number(),
    message: z.string(),
  }),
  link: ({ result }) => ({
    url: buildDeepLink({
      view: "map",
      to: `/projects/${encodeURIComponent(result.id)}`,
      params: { projectId: result.id },
    }),
    label: `Open ${result.name}`,
  }),
  run: async (args, ctx) => {
    const ownerEmail =
      ctx?.userEmail ?? fail("Sign in to import a repo.", { statusCode: 401 });
    const orgId = ctx?.orgId ?? null;
    const id = crypto.randomUUID();

    let repoPath: string;
    let name: string;
    let repoUrl: string | null = null;
    if (args.source === "demo") {
      repoPath = DEMO_REPO_PATH;
      name = "tallyhub";
    } else {
      if (!args.repoUrl) fail("repoUrl is required for a GitHub import.", { errorCode: "invalid_repo_url" });
      const parsed = parseGithubUrl(args.repoUrl);
      repoPath = await cloneRepo(parsed.url, id);
      name = parsed.repo;
      repoUrl = `https://github.com/${parsed.owner}/${parsed.repo}`;
    }
    let source: SchemaSource;
    let dumpPath: string;
    try {
      source = await findSchemaSource(repoPath, args.dumpPath);
      dumpPath = await materializeSource(id, repoPath, source);
    } catch (error) {
      if (args.source === "github") await removeCheckout(repoPath);
      throw error;
    }

    let snapshot;
    let report: LoadReport | undefined;
    try {
      const pg = await loadDump(dumpPath);
      report = loadReport(pg);
      snapshot = await introspect(pg);
      await pg.close();
    } catch (error) {
      if (args.source === "github") await removeCheckout(repoPath);
      fail(
        `The database from ${describeSource(repoPath, source)} did not load into Postgres: ${(error as Error).message}`,
        { errorCode: "dump_invalid" },
      );
    }
    if (snapshot.tables.length === 0) {
      fail("The dump loaded but has no tables in the public schema.", { errorCode: "dump_invalid" });
    }

    const code = await analyzeCode(repoPath, snapshot);
    const scope = { ownerEmail, orgId };
    const db = getDb();
    await db.insert(schema.projects).values({
      id,
      name,
      source: args.source,
      repoUrl,
      repoPath,
      dumpPath,
      schema: snapshot,
      code,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...scope,
      visibility: orgId ? "org" : "private",
    });
    const positions = layoutTables(snapshot);
    await db.insert(schema.mapNodes).values(
      snapshot.tables.map((table) => ({
        id: crypto.randomUUID(),
        projectId: id,
        key: `table:${table.name}`,
        kind: "table" as const,
        label: table.name,
        x: positions.get(table.name)?.x ?? 0,
        y: positions.get(table.name)?.y ?? 0,
        ...scope,
      })),
    );
    const modulePositions = layoutModules(code.modules, positions);
    if (code.modules.length) {
      await db.insert(schema.mapNodes).values(
        code.modules.map((module) => ({
          id: crypto.randomUUID(),
          projectId: id,
          key: `module:${module.path}`,
          kind: "module" as const,
          label: module.label,
          x: modulePositions.get(module.path)?.x ?? 0,
          y: modulePositions.get(module.path)?.y ?? 0,
          ...scope,
        })),
      );
    }
    const usageEdges = new Map<string, "reads" | "writes">();
    const tableNames = new Set(snapshot.tables.map((t) => t.name));
    for (const usage of code.usages) {
      // Code can query a table the sandbox could not load (a skipped extension).
      if (!tableNames.has(usage.table)) continue;
      const key = `${usage.module}\u0000${usage.table}`;
      if (usage.kind === "write" || !usageEdges.has(key)) {
        usageEdges.set(key, usage.kind === "write" ? "writes" : "reads");
      }
    }
    const edges: (typeof schema.mapEdges.$inferInsert)[] = snapshot.tables.flatMap((table) =>
      table.foreignKeys.map((fk) => ({
        id: crypto.randomUUID(),
        projectId: id,
        kind: "foreign_key" as const,
        sourceKey: `table:${table.name}`,
        targetKey: `table:${fk.refTable}`,
        label: `${fk.columns.join(", ")} → ${fk.refColumns.join(", ")}`,
        ...scope,
      })),
    );
    for (const [key, kind] of usageEdges) {
      const [module, table] = key.split("\u0000");
      edges.push({
        id: crypto.randomUUID(),
        projectId: id,
        kind,
        sourceKey: `module:${module}`,
        targetKey: `table:${table}`,
        label: null,
        ...scope,
      });
    }
    if (edges.length) await db.insert(schema.mapEdges).values(edges);

    const rows = snapshot.tables.reduce((sum, t) => sum + t.rowCount, 0);
    return {
      id,
      name,
      tables: snapshot.tables.length,
      rows,
      message: `Imported ${name}: ${snapshot.tables.length} tables from ${describeSource(repoPath, source)}, ${rows ? `${rows} row${rows === 1 ? "" : "s"} of sample data` : "no sample data (rehearsals check the schema only)"}, ${code.usages.length} queries in ${code.modules.length} modules${code.approximate ? ADAPTER_NOTE[code.adapter] : ""}.${skippedNote(report)}`,
    };
  },
});

/** Says what the sandbox left out because PGlite lacks an extension. */
function skippedNote(report: LoadReport | undefined) {
  if (!report) return "";
  const ext = report.missing.join(", ");
  const tables = report.skippedTables.length ? ` (tables not loaded: ${report.skippedTables.slice(0, 8).join(", ")}${report.skippedTables.length > 8 ? ", ..." : ""})` : "";
  return ` The sandbox has no ${ext} extension, so ${report.skipped} statements could not run and were skipped${tables}; changes to those parts cannot be rehearsed.`;
}

const ADAPTER_NOTE: Record<string, string> = {
  prisma: " (Prisma calls, matched by pattern)",
  "supabase-js": " (supabase-js calls, matched by pattern)",
  "text-search": " (approximate text search)",
};
