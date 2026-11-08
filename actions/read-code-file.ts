import { defineAction, fail } from "@agent-native/core/action";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { findOpenChangeset, requireProject } from "../server/lib/projects.js";
import { hasWorkspace, readWorkspaceFile, resolveInside, workspacePath } from "../server/lib/workspace.js";

export default defineAction({
  description:
    "Read a source file from the project's repo, as it stands in the changeset's working copy (with any fixes applied). Lines are numbered so edits can target them.",
  schema: z.object({
    projectId: z.string().describe("Project id"),
    path: z.string().describe("Repo-relative path, e.g. src/modules/auth/users.ts"),
  }),
  http: { method: "GET" },
  readOnly: true,
  outputSchema: z.object({ path: z.string(), content: z.string(), lines: z.number(), source: z.enum(["workspace", "repo"]) }),
  run: async (args) => {
    const project = await requireProject(args.projectId);
    const changeset = await findOpenChangeset(project.id);
    let content: string | null;
    let source: "workspace" | "repo";
    if (changeset && (await hasWorkspace(changeset.id))) {
      content = await readWorkspaceFile(workspacePath(changeset.id), args.path);
      source = "workspace";
    } else {
      try {
        content = await readFile(resolveInside(project.repoPath, args.path), "utf8");
      } catch {
        content = null;
      }
      source = "repo";
    }
    if (content === null) fail(`No file at ${args.path}.`, { errorCode: "file_not_found", statusCode: 404 });
    const lines = content.split("\n");
    return {
      path: args.path,
      content: lines.map((line, i) => `${String(i + 1).padStart(4)}  ${line}`).join("\n"),
      lines: lines.length,
      source,
    };
  },
});
