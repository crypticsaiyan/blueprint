import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { findOpenChangeset, requireProject } from "../server/lib/projects.js";
import { cancelTestJob } from "../server/lib/test-jobs.js";

export default defineAction({
  description: "Stop a running run-tests for the project's changeset: kills the install, suite or typecheck in progress. The working copy keeps its changes.",
  schema: z.object({ projectId: z.string().describe("Project id") }),
  parallelSafe: true,
  outputSchema: z.object({ cancelled: z.boolean(), message: z.string() }),
  run: async ({ projectId }) => {
    await requireProject(projectId, "editor");
    const changeset = await findOpenChangeset(projectId);
    const cancelled = changeset ? cancelTestJob(changeset.id) : false;
    return { cancelled, message: cancelled ? "Cancelling the test run." : "No test run is in progress." };
  },
});
