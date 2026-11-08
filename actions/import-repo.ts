import { defineAction, fail } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import path from "node:path";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  cloneRepo,
  DEMO_REPO_PATH,
  findDump,
  parseGithubUrl,
  removeCheckout,
} from "../server/lib/import.js";
import { introspect } from "../server/lib/introspect.js";
import { layoutTables, nowIso } from "../server/lib/projects.js";
import { loadDump } from "../server/lib/sandbox.js";

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
      .describe("Path to the SQL dump inside the repo; found automatically when omitted"),
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
    let dumpPath: string;
    try {
      dumpPath = await findDump(repoPath, args.dumpPath);
    } catch (error) {
      if (args.source === "github") await removeCheckout(repoPath);
      throw error;
    }

    let snapshot;
    try {
      const pg = await loadDump(dumpPath);
      snapshot = await introspect(pg);
      await pg.close();
    } catch (error) {
      if (args.source === "github") await removeCheckout(repoPath);
      fail(
        `The dump at ${path.relative(repoPath, dumpPath)} did not load into Postgres: ${(error as Error).message}`,
        { errorCode: "dump_invalid" },
      );
    }
    if (snapshot.tables.length === 0) {
      fail("The dump loaded but has no tables in the public schema.", { errorCode: "dump_invalid" });
    }

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
    const edges = snapshot.tables.flatMap((table) =>
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
    if (edges.length) await db.insert(schema.mapEdges).values(edges);

    const rows = snapshot.tables.reduce((sum, t) => sum + t.rowCount, 0);
    return {
      id,
      name,
      tables: snapshot.tables.length,
      rows,
      message: `Imported ${name}: ${snapshot.tables.length} tables, ${rows} rows of sample data.`,
    };
  },
});
