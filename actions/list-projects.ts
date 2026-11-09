import { defineAction } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { isMaterializedSource } from "../server/lib/schema-source.js";

const status = z.object({ status: z.string(), stale: z.boolean() }).nullable();

export default defineAction({
  description:
    "List imported Blueprint projects (repo plus sample database), newest first, with where each open changeset stands: change count, latest rehearsal, latest test run and pull request.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  outputSchema: z.object({
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        source: z.string(),
        repoUrl: z.string().nullable(),
        tables: z.number(),
        createdAt: z.string(),
        updatedAt: z.string(),
        /** How the code is read: typescript-drizzle, prisma, supabase-js or text-search. */
        adapter: z.string().nullable(),
        /** "dump" when the schema came from a SQL dump, "migrations" when rebuilt from them. */
        schemaSource: z.enum(["dump", "migrations"]),
        goal: z.string().nullable(),
        changes: z.number(),
        rehearsal: status,
        test: status,
        pullRequest: z.object({ number: z.number(), url: z.string() }).nullable(),
      }),
    ),
  }),
  link: () => ({ url: buildDeepLink({ view: "projects", to: "/projects" }), label: "Open projects" }),
  run: async () => {
    const { projects, projectShares, changesets, changeItems, rehearsals, testRuns, pullRequests } = schema;
    const db = getDb();
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        source: projects.source,
        repoUrl: projects.repoUrl,
        dumpPath: projects.dumpPath,
        schema: projects.schema,
        code: projects.code,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(accessFilter(projects, projectShares))
      .orderBy(desc(projects.createdAt))
      .limit(100);
    const ids = rows.map((r) => r.id);
    const open = ids.length
      ? await db
          .select({ id: changesets.id, projectId: changesets.projectId, goal: changesets.goal, updatedAt: changesets.updatedAt })
          .from(changesets)
          .where(and(inArray(changesets.projectId, ids), eq(changesets.status, "open")))
      : [];
    const csIds = open.map((c) => c.id);
    const [items, rehearsalRows, testRows, prRows] = csIds.length
      ? await Promise.all([
          db
            .select({ changesetId: changeItems.changesetId })
            .from(changeItems)
            .where(and(inArray(changeItems.changesetId, csIds), ne(changeItems.status, "rejected"))),
          db
            .select({ changesetId: rehearsals.changesetId, status: rehearsals.status, createdAt: rehearsals.createdAt })
            .from(rehearsals)
            .where(inArray(rehearsals.changesetId, csIds))
            .orderBy(desc(rehearsals.createdAt)),
          db
            .select({ changesetId: testRuns.changesetId, status: testRuns.status, createdAt: testRuns.createdAt })
            .from(testRuns)
            .where(inArray(testRuns.changesetId, csIds))
            .orderBy(desc(testRuns.createdAt)),
          db
            .select({ changesetId: pullRequests.changesetId, number: pullRequests.number, url: pullRequests.url })
            .from(pullRequests)
            .where(inArray(pullRequests.changesetId, csIds))
            .orderBy(desc(pullRequests.createdAt)),
        ])
      : [[], [], [], []];
    // Rows come newest first, so the first one per changeset is the latest.
    const latest = <T extends { changesetId: string }>(list: T[]) => {
      const out = new Map<string, T>();
      for (const row of list) if (!out.has(row.changesetId)) out.set(row.changesetId, row);
      return out;
    };
    const lastRehearsal = latest(rehearsalRows);
    const lastTest = latest(testRows);
    const lastPr = latest(prRows);
    return {
      projects: rows.map((row) => {
        const cs = open.find((c) => c.projectId === row.id);
        const rehearsal = cs ? lastRehearsal.get(cs.id) : undefined;
        const test = cs ? lastTest.get(cs.id) : undefined;
        const pr = cs ? lastPr.get(cs.id) : undefined;
        const updatedAt = [row.updatedAt, cs?.updatedAt, rehearsal?.createdAt, test?.createdAt].filter(Boolean).sort().pop()!;
        return {
          id: row.id,
          name: row.name,
          source: row.source,
          repoUrl: row.repoUrl,
          tables: row.schema.tables.length,
          createdAt: row.createdAt,
          updatedAt,
          adapter: row.code?.adapter ?? null,
          schemaSource: isMaterializedSource(row.dumpPath) ? ("migrations" as const) : ("dump" as const),
          goal: cs?.goal || null,
          changes: cs ? items.filter((i) => i.changesetId === cs.id).length : 0,
          rehearsal: rehearsal && cs ? { status: rehearsal.status, stale: rehearsal.createdAt < cs.updatedAt } : null,
          test: test && cs ? { status: test.status, stale: test.createdAt < cs.updatedAt } : null,
          pullRequest: pr ? { number: pr.number, url: pr.url } : null,
        };
      }),
    };
  },
});
