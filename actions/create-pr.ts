import { defineAction, fail } from "@agent-native/core/action";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { activeItems, describeChange } from "../shared/changes.js";
import { getDb, schema } from "../server/db/index.js";
import { githubToken, openPullRequest, parseRepo } from "../server/lib/github.js";
import { findOpenChangeset, loadItems, nowIso, requireProject, scopeOf } from "../server/lib/projects.js";
import { shipReadiness } from "../server/lib/ship-status.js";
import { workspaceDiff, workspacePath, hasWorkspace } from "../server/lib/workspace.js";

export default defineAction({
  description:
    "Open one GitHub pull request with everything in the changeset: migration with conflict fixes, updated Drizzle schema, fixed queries, migrated sample data, and rule checks. Requires a passing rehearsal and passing tests on the current code. Ask the user before calling.",
  schema: z.object({
    projectId: z.string().describe("Project id"),
    repo: z.string().optional().describe('Target GitHub repo "owner/name"; defaults to the imported repo'),
    title: z.string().optional().describe("PR title; defaults to the changeset goal"),
  }),
  needsApproval: true,
  outputSchema: z.object({ id: z.string(), url: z.string(), number: z.number(), branch: z.string(), message: z.string() }),
  link: ({ result }) => ({ url: result.url, label: `Open PR #${result.number}` }),
  run: async ({ projectId, repo, title }) => {
    const project = await requireProject(projectId, "editor");
    const changeset = await findOpenChangeset(projectId);
    if (!changeset || !(await hasWorkspace(changeset.id))) {
      fail("Nothing to ship yet: rehearse, fix, and run the tests first.", { errorCode: "nothing_to_ship" });
    }
    const target = repo ?? project.githubRepo ?? project.repoUrl;
    if (!target) fail('Which GitHub repo? Pass repo as "owner/name".', { errorCode: "repo_required" });
    const { owner, repo: name } = parseRepo(target);
    const readiness = await shipReadiness(projectId, changeset);
    if (!readiness.ready) fail(readiness.blockers.join(" "), { errorCode: "not_ready", statusCode: 409 });

    const token = await githubToken();
    const diff = await workspaceDiff(workspacePath(changeset.id));
    if (!diff.patch.trim()) fail("The working copy has no changes.", { errorCode: "nothing_to_ship" });
    const items = activeItems(await loadItems(changeset.id));
    const db = getDb();
    const rehearsal = readiness.rehearsal;
    const [latest] = await db
      .select({ result: schema.rehearsals.result })
      .from(schema.rehearsals)
      .where(eq(schema.rehearsals.changesetId, changeset.id))
      .orderBy(desc(schema.rehearsals.createdAt))
      .limit(1);
    const fixes = (latest?.result.conflicts ?? []).filter((c) => c.fixResult);
    const edits = await db
      .select({ path: schema.codeEdits.path, summary: schema.codeEdits.summary, origin: schema.codeEdits.origin })
      .from(schema.codeEdits)
      .where(eq(schema.codeEdits.changesetId, changeset.id))
      .limit(300);
    const goal = changeset.goal || "Schema and code changes";
    const prTitle = title ?? goal.charAt(0).toUpperCase() + goal.slice(1);
    const test = readiness.test!;
    const body = [
      `## ${prTitle}`,
      "",
      items.length ? "### Schema changes" : "",
      ...items.map((i) => `- ${describeChange(i.payload)}: ${i.reason}`),
      fixes.length ? "\n### Data fixes (in the migration, before the step they unblock)" : "",
      ...fixes.map((c) => `- ${c.message} Fix: ${c.fixResult}.`),
      "\n### Files",
      ...diff.files.map((f) => {
        const edit = edits.find((e) => e.path === f.path);
        return `- \`${f.path}\` (+${f.additions} −${f.deletions})${edit ? `: ${edit.summary}` : ""}`;
      }),
      "\n### Verification",
      rehearsal ? `- Rehearsed on a copy of the sample data: ${rehearsal.status}.` : "",
      `- \`${test.command}\`: ${test.passed}/${test.total} passed against the migrated data.`,
    ]
      .filter((line) => line !== "")
      .join("\n");
    const branch = `blueprint/${(changeset.goal || "changes").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "changes"}-${changeset.id.slice(0, 6)}`;
    const pr = await openPullRequest({
      token,
      owner,
      repo: name,
      patch: diff.patch,
      branch,
      title: prTitle,
      body,
      commitMessage: prTitle,
    });
    const id = crypto.randomUUID();
    await db.insert(schema.pullRequests).values({
      id,
      changesetId: changeset.id,
      projectId,
      url: pr.url,
      number: pr.number,
      branch,
      createdAt: nowIso(),
      ...scopeOf(project),
    });
    if (!project.githubRepo) {
      await db.update(schema.projects).set({ githubRepo: `${owner}/${name}` }).where(eq(schema.projects.id, projectId));
    }
    return { id, url: pr.url, number: pr.number, branch, message: `Opened PR #${pr.number}: ${pr.url}` };
  },
});
