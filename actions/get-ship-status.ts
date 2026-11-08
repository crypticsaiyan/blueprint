import { defineAction } from "@agent-native/core/action";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { findOpenChangeset, requireProject } from "../server/lib/projects.js";
import { shipReadiness } from "../server/lib/ship-status.js";
import { hasWorkspace, workspaceDiff, workspacePath } from "../server/lib/workspace.js";

const MAX_PATCH = 400_000;

export default defineAction({
  description:
    "Read what would ship: the full diff of the changeset's working copy (migration, schema, fixed code, migrated data, rule check), the latest test run, readiness blockers, and the pull request if one exists.",
  schema: z.object({ projectId: z.string().describe("Project id") }),
  http: { method: "GET" },
  readOnly: true,
  outputSchema: z.object({
    githubRepo: z.string().nullable(),
    files: z.array(z.object({ path: z.string(), status: z.string(), additions: z.number(), deletions: z.number(), summary: z.string().nullable(), origin: z.string().nullable() })),
    patch: z.string(),
    truncated: z.boolean(),
    test: z
      .object({
        id: z.string(),
        status: z.string(),
        total: z.number(),
        passed: z.number(),
        failed: z.number(),
        command: z.string(),
        createdAt: z.string(),
        durationMs: z.number(),
        cases: z.array(z.object({ name: z.string(), file: z.string(), status: z.string(), message: z.string().optional() })),
        output: z.string(),
      })
      .nullable(),
    ready: z.boolean(),
    blockers: z.array(z.string()),
    pullRequest: z.object({ url: z.string(), number: z.number(), branch: z.string(), createdAt: z.string() }).nullable(),
  }),
  run: async ({ projectId }) => {
    const project = await requireProject(projectId);
    const githubRepo = project.githubRepo ?? (project.repoUrl ? project.repoUrl.replace("https://github.com/", "") : null);
    const changeset = await findOpenChangeset(projectId);
    if (!changeset) {
      return { githubRepo, files: [], patch: "", truncated: false, test: null, ready: false, blockers: ["Nothing to ship yet."], pullRequest: null };
    }
    const db = getDb();
    const edits = await db
      .select({ path: schema.codeEdits.path, summary: schema.codeEdits.summary, origin: schema.codeEdits.origin })
      .from(schema.codeEdits)
      .where(eq(schema.codeEdits.changesetId, changeset.id))
      .orderBy(desc(schema.codeEdits.createdAt))
      .limit(300);
    const diff = (await hasWorkspace(changeset.id)) ? await workspaceDiff(workspacePath(changeset.id)) : { files: [], patch: "" };
    const readiness = await shipReadiness(projectId, changeset);
    const [pr] = await db
      .select({ url: schema.pullRequests.url, number: schema.pullRequests.number, branch: schema.pullRequests.branch, createdAt: schema.pullRequests.createdAt })
      .from(schema.pullRequests)
      .where(eq(schema.pullRequests.changesetId, changeset.id))
      .orderBy(desc(schema.pullRequests.createdAt))
      .limit(1);
    const test = readiness.test;
    return {
      githubRepo,
      files: diff.files.map((f) => {
        const edit = edits.find((e) => e.path === f.path);
        return { ...f, summary: edit?.summary ?? null, origin: edit?.origin ?? null };
      }),
      patch: diff.patch.slice(0, MAX_PATCH),
      truncated: diff.patch.length > MAX_PATCH,
      test: test
        ? {
            id: test.id,
            status: test.status,
            total: test.total,
            passed: test.passed,
            failed: test.failed,
            command: test.command,
            createdAt: test.createdAt,
            durationMs: test.durationMs,
            cases: test.cases.map((c) => ({ name: c.name, file: c.file, status: c.status, ...(c.message ? { message: c.message } : {}) })),
            output: test.output.slice(-20000),
          }
        : null,
      ready: readiness.ready,
      blockers: readiness.blockers,
      pullRequest: pr ?? null,
    };
  },
});
