import { eq } from "drizzle-orm";

import type { CodeAnalysis } from "../../shared/code-types.js";
import { getDb, schema } from "../db/index.js";
import { analyzeCode } from "./code/index.js";
import type { ChangesetRow, ProjectRow } from "./projects.js";
import { hasWorkspace, workspacePath } from "./workspace.js";

/** The code as it stands for this changeset: the workspace once it exists. */
export async function currentAnalysis(
  project: ProjectRow,
  changeset: ChangesetRow | null,
  options: { refresh?: boolean } = {},
): Promise<CodeAnalysis | null> {
  if (changeset && (await hasWorkspace(changeset.id))) {
    if (!options.refresh && changeset.code) return changeset.code;
    const analysis = await analyzeCode(workspacePath(changeset.id), project.schema);
    await getDb().update(schema.changesets).set({ code: analysis }).where(eq(schema.changesets.id, changeset.id));
    return analysis;
  }
  if (!project.code || options.refresh) {
    const analysis = await analyzeCode(project.repoPath, project.schema);
    await getDb().update(schema.projects).set({ code: analysis }).where(eq(schema.projects.id, project.id));
    return analysis;
  }
  return project.code;
}
