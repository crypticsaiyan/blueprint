import { defineAction, fail } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { z } from "zod";

import { activeItems } from "../shared/changes.js";
import { getDb, schema } from "../server/db/index.js";
import { changesetForCode } from "../server/lib/changeset-guard.js";
import { loadItems, nowIso, requireProject, scopeOf } from "../server/lib/projects.js";
import { syncWorkspace } from "../server/lib/ship.js";
import { progress, TestsCancelledError, withTestJob } from "../server/lib/test-jobs.js";
import { prepareDependencies, restoreStashedChanges, runRepoTests } from "../server/lib/test-runner.js";
import { ensureWorkspace } from "../server/lib/workspace.js";

export default defineAction({
  description:
    "Run the repo's tests, typecheck, and dependency-rule check in the changeset's working copy, against the migrated sample data (the rehearsal must pass first). Returns each failing test with its error. Can take minutes on a large repo; get-test-progress reads the current step and cancel-tests stops it.",
  schema: z.object({ projectId: z.string().describe("Project id") }),
  outputSchema: z.object({
    id: z.string(),
    status: z.enum(["passed", "failed", "error", "none"]),
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    failures: z.array(z.object({ name: z.string(), file: z.string(), message: z.string() })),
    message: z.string(),
  }),
  link: ({ args }) => ({
    url: buildDeepLink({ view: "ship", to: `/projects/${encodeURIComponent(args.projectId)}/ship`, params: { projectId: args.projectId } }),
    label: "Open ship",
  }),
  run: async ({ projectId }) => {
    const project = await requireProject(projectId, "editor");
    const changeset = await changesetForCode(project);
    const items = await loadItems(changeset.id);
    const result = await withTestJob(changeset.id, async () => {
      try {
        progress("Preparing the working copy");
        // Dependencies first: the sync uses the repo's own drizzle-kit when present.
        const workspace = await ensureWorkspace(project, changeset);
        await restoreStashedChanges(workspace);
        const prepared = await prepareDependencies(workspace);
        progress("Writing the migration and generated files");
        const sync = await syncWorkspace(project, changeset);
        if (activeItems(items).length && sync.pending) {
          fail(sync.pending, { errorCode: "rehearsal_not_passed" });
        }
        return await runRepoTests(sync.dir, prepared);
      } catch (error) {
        if (error instanceof TestsCancelledError) {
          fail("Tests cancelled. The working copy keeps its changes; run the tests again when ready.", {
            errorCode: "tests_cancelled",
            statusCode: 409,
          });
        }
        throw error;
      }
    });
    const passed = result.cases.filter((c) => c.status === "passed").length;
    const failed = result.cases.filter((c) => c.status === "failed").length;
    const preexisting = result.cases.filter((c) => c.status === "preexisting").length;
    const known = preexisting ? ` ${preexisting} other checks fail on the untouched code too, so they do not block.` : "";
    const id = crypto.randomUUID();
    await getDb().insert(schema.testRuns).values({
      id,
      changesetId: changeset.id,
      projectId: project.id,
      status: result.status,
      command: result.command,
      total: result.cases.length,
      passed,
      failed,
      cases: result.cases,
      output: result.output,
      durationMs: result.durationMs,
      createdAt: nowIso(),
      ...scopeOf(project),
    });
    const failures = result.cases
      .filter((c) => c.status === "failed")
      .map((c) => ({ name: c.name, file: c.file, message: (c.message ?? "").slice(0, 600) }));
    return {
      id,
      status: result.status,
      total: result.cases.length,
      passed,
      failed,
      failures,
      message:
        result.status === "passed"
          ? `${preexisting ? `No new failures: ${passed} checks passed` : `All ${passed} checks passed`}${project.schema.tables.some((t) => t.rowCount > 0) ? " against the migrated data" : ""} (${result.command}).${known}`
          : result.status === "error" || result.status === "none"
            ? result.output.slice(0, 300)
            : `${failed} of ${result.cases.length} checks failed: ${failures.map((f) => f.name).slice(0, 6).join("; ")}.${known}`,
    };
  },
});
