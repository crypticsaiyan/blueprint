import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { computeImpact } from "../shared/impact.js";
import { findViolations } from "../shared/rules.js";
import { getDb, schema } from "../server/db/index.js";
import { changesetForCode } from "../server/lib/changeset-guard.js";
import { currentAnalysis } from "../server/lib/code-state.js";
import { loadItems, nowIso, requireProject, scopeOf } from "../server/lib/projects.js";
import { generatedPaths, syncWorkspace } from "../server/lib/ship.js";
import { assertWorkspaceFree } from "../server/lib/test-jobs.js";
import { eq } from "drizzle-orm";
import { readWorkspaceFile, writeWorkspaceFile } from "../server/lib/workspace.js";

const editSchema = z.union([
  z.object({
    path: z.string().describe("Repo-relative file path"),
    find: z.string().min(1).describe("Exact text to replace; must occur exactly once in the file"),
    replace: z.string().describe("Replacement text"),
  }),
  z.object({
    path: z.string().describe("Repo-relative file path; may be a new file"),
    content: z.string().describe("Full new file content"),
  }),
]);

export default defineAction({
  description:
    "Apply code edits to the changeset's working copy to fix queries the migration breaks (or dependency-rule violations). Each edit is an exact find/replace that must match once, or a full file. The Drizzle schema, migration, and sample data are generated from the changeset: change the changeset, not those files. Returns what still breaks. Read files with read-code-file first; run run-tests after.",
  schema: z.object({
    projectId: z.string().describe("Project id"),
    summary: z.string().min(1).describe("One line: what the edits fix"),
    edits: z.array(editSchema).min(1).max(30),
  }),
  outputSchema: z.object({
    files: z.array(z.string()),
    breaks: z.number(),
    violations: z.number(),
    message: z.string(),
    nextRequiredAction: z.string().optional(),
  }),
  run: async ({ projectId, summary, edits }) => {
    const project = await requireProject(projectId, "editor");
    const changeset = await changesetForCode(project);
    assertWorkspaceFree(changeset.id);
    const { dir } = await syncWorkspace(project, changeset);
    const generated = await generatedPaths(project, changeset);

    // Validate every edit before writing any, so a bad edit changes nothing.
    const next = new Map<string, string>();
    for (const [index, edit] of edits.entries()) {
      const rel = edit.path.replace(/^\.?\//, "");
      if (generated.has(rel)) {
        fail(`Edit ${index + 1}: ${rel} is generated from the changeset; change the changeset instead.`, {
          errorCode: "generated_file",
        });
      }
      const current = next.get(rel) ?? (await readWorkspaceFile(dir, rel));
      if ("content" in edit) {
        next.set(rel, edit.content);
        continue;
      }
      if (current === null) fail(`Edit ${index + 1}: ${rel} does not exist.`, { errorCode: "file_not_found" });
      const count = current.split(edit.find).length - 1;
      if (count !== 1) {
        fail(
          `Edit ${index + 1}: the find text occurs ${count} times in ${rel}; it must occur exactly once. Include more surrounding lines.`,
          { errorCode: "ambiguous_edit" },
        );
      }
      next.set(rel, current.replace(edit.find, () => edit.replace));
    }
    for (const [rel, content] of next) await writeWorkspaceFile(dir, rel, content);

    const db = getDb();
    await db.insert(schema.codeEdits).values(
      [...next.keys()].map((file) => ({
        id: crypto.randomUUID(),
        changesetId: changeset.id,
        projectId: project.id,
        path: file,
        summary,
        origin: "agent" as const,
        createdAt: nowIso(),
        ...scopeOf(project),
      })),
    );
    const analysis = await currentAnalysis(project, changeset, { refresh: true });
    const items = await loadItems(changeset.id);
    const breaks = analysis ? computeImpact(analysis, items).filter((i) => i.severity === "breaks").length : 0;
    const rules = await db.select().from(schema.rules).where(eq(schema.rules.projectId, project.id)).limit(200);
    const violations = analysis ? findViolations(analysis, rules).length : 0;
    return {
      files: [...next.keys()],
      breaks,
      violations,
      message: `Edited ${next.size} file${next.size === 1 ? "" : "s"}: ${[...next.keys()].join(", ")}. ${breaks} predicted breaks and ${violations} rule violations remain.`,
      nextRequiredAction: "run-tests",
    };
  },
});
