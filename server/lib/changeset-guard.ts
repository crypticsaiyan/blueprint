import { fail } from "@agent-native/core/action";

import { findOpenChangeset, openChangeset, type ProjectRow } from "./projects.js";

/** Code work needs a changeset to hang the working copy on; rule fixes may not have one yet. */
export async function changesetForCode(project: ProjectRow) {
  const existing = await findOpenChangeset(project.id);
  if (existing) return existing;
  const created = await openChangeset(project, "");
  if (!created) fail("Could not open a changeset.", { errorCode: "no_changeset" });
  return created;
}
