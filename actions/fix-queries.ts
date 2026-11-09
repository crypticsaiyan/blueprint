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

/** The file's real text around the find text's first line, so the next try can copy it exactly. */
function nearMatch(file: string, find: string): string {
  const lines = file.split("\n");
  const probe = find.split("\n").map((l) => l.trim()).find((l) => l.length >= 8);
  if (!probe) return "";
  const at = lines.findIndex((l) => l.includes(probe) || l.trim() === probe);
  if (at < 0) return " Its first line does not appear either; read the file again with read-code-file.";
  const from = Math.max(0, at - 3);
  const snippet = lines
    .slice(from, at + 6)
    .map((l, i) => `${from + i + 1}: ${l}`)
    .join("\n");
  return ` The closest match is near line ${at + 1}; the file actually reads:\n${snippet}\n`;
}

export default defineAction({
  description:
    "Apply code edits to the changeset's working copy to fix queries the migration breaks (or dependency-rule violations). Each edit is an exact find/replace that must match once, or a full file. Edits are all-or-nothing: if any edit is rejected, nothing is written, so fix that edit and call again. The Drizzle schema, migration, and sample data are generated from the changeset: change the changeset, not those files. Returns what still breaks. Read files with read-code-file first; run run-tests after.",
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
    const unchanged = " No edits were applied; the working copy is unchanged. Fix this edit and call fix-queries again with all edits.";
    const next = new Map<string, string>();
    for (const [index, edit] of edits.entries()) {
      const rel = edit.path.replace(/^\.?\//, "");
      if (generated.has(rel)) {
        fail(`Edit ${index + 1}: ${rel} is generated from the changeset; change the changeset instead.${unchanged}`, {
          errorCode: "generated_file",
        });
      }
      const current = next.get(rel) ?? (await readWorkspaceFile(dir, rel));
      if ("content" in edit) {
        next.set(rel, edit.content);
        continue;
      }
      if (current === null) fail(`Edit ${index + 1}: ${rel} does not exist.${unchanged}`, { errorCode: "file_not_found" });
      const count = current.split(edit.find).length - 1;
      if (count === 0) {
        fail(`Edit ${index + 1}: the find text is not in ${rel}.${nearMatch(current, edit.find)}${unchanged}`, {
          errorCode: "edit_not_found",
        });
      }
      if (count > 1) {
        fail(
          `Edit ${index + 1}: the find text occurs ${count} times in ${rel}; it must occur exactly once. Include more surrounding lines.${unchanged}`,
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
