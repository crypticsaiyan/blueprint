import { defineAction, fail } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { z } from "zod";

import { activeItems } from "../shared/changes.js";
import { getDb, schema } from "../server/db/index.js";
import { changesetForCode } from "../server/lib/changeset-guard.js";
import { loadItems, nowIso, requireProject, scopeOf } from "../server/lib/projects.js";
import { syncWorkspace } from "../server/lib/ship.js";
import { runRepoTests } from "../server/lib/test-runner.js";

export default defineAction({
  description:
    "Run the repo's tests, typecheck, and dependency-rule check in the changeset's working copy, against the migrated sample data (the rehearsal must pass first). Returns each failing test with its error.",
  schema: z.object({ projectId: z.string().describe("Project id") }),
  outputSchema: z.object({
    id: z.string(),
    status: z.enum(["passed", "failed", "error"]),
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
    const sync = await syncWorkspace(project, changeset);
    if (activeItems(items).length && sync.pending) {
      fail(sync.pending, { errorCode: "rehearsal_not_passed" });
    }
    const result = await runRepoTests(sync.dir);
    const passed = result.cases.filter((c) => c.status === "passed").length;
    const failed = result.cases.filter((c) => c.status === "failed").length;
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
          ? `All ${passed} checks passed against the migrated data (${result.command}).`
          : result.status === "error"
            ? result.output.slice(0, 300)
            : `${failed} of ${result.cases.length} checks failed: ${failures.map((f) => f.name).slice(0, 6).join("; ")}.`,
    };
  },
});
