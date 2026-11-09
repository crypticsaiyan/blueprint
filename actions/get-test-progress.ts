import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { findOpenChangeset, requireProject } from "../server/lib/projects.js";
import { testJob } from "../server/lib/test-jobs.js";

export default defineAction({
  description: "Read whether run-tests is running for the project's changeset, and the step it is on (installing, a suite, the typecheck).",
  schema: z.object({ projectId: z.string().describe("Project id") }),
  http: { method: "GET" },
  readOnly: true,
  parallelSafe: true,
  outputSchema: z.object({
    running: z.boolean(),
    phase: z.string().nullable(),
    startedAt: z.string().nullable(),
    steps: z.array(z.string()),
    cancelling: z.boolean(),
  }),
  run: async ({ projectId }) => {
    await requireProject(projectId);
    const changeset = await findOpenChangeset(projectId);
    const job = changeset ? testJob(changeset.id) : null;
    return job
      ? { running: true, ...job }
      : { running: false, phase: null, startedAt: null, steps: [], cancelling: false };
  },
});
