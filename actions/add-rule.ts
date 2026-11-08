import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { findViolations } from "../shared/rules.js";
import { getDb, schema } from "../server/db/index.js";
import { currentAnalysis } from "../server/lib/code-state.js";
import { findOpenChangeset, nowIso, requireProject, scopeOf } from "../server/lib/projects.js";

export default defineAction({
  description:
    "Forbid a module dependency: code under fromModule must not import code under toModule (path prefixes). Saves the rule as a CI check that ships with the PR and returns current violations with file and line.",
  schema: z.object({
    projectId: z.string().describe("Project id"),
    fromModule: z.string().min(1).describe("Importing module path or folder, e.g. src/modules/customers"),
    toModule: z.string().min(1).describe("Imported module path or folder, e.g. src/modules/billing"),
    reason: z.string().default("").describe("Why the dependency is forbidden"),
  }),
  outputSchema: z.object({
    id: z.string(),
    violations: z.array(z.object({ from: z.string(), to: z.string(), line: z.number() })),
    message: z.string(),
    nextRequiredAction: z.string().optional(),
  }),
  run: async ({ projectId, fromModule, toModule, reason }) => {
    const project = await requireProject(projectId, "editor");
    if (fromModule === toModule) fail("A module cannot be forbidden from importing itself.", { errorCode: "invalid_rule" });
    const db = getDb();
    const [existing] = await db
      .select({ id: schema.rules.id })
      .from(schema.rules)
      .where(and(eq(schema.rules.projectId, projectId), eq(schema.rules.fromModule, fromModule), eq(schema.rules.toModule, toModule)))
      .limit(1);
    const id = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      await db.insert(schema.rules).values({ id, projectId, fromModule, toModule, reason, createdAt: nowIso(), ...scopeOf(project) });
    }
    const changeset = await findOpenChangeset(projectId);
    if (changeset) {
      await db.update(schema.changesets).set({ updatedAt: nowIso() }).where(eq(schema.changesets.id, changeset.id));
    }
    const analysis = await currentAnalysis(project, changeset);
    const violations = analysis ? findViolations(analysis, [{ fromModule, toModule, reason }]) : [];
    return {
      id,
      violations: violations.map(({ from, to, line }) => ({ from, to, line })),
      message: violations.length
        ? `Rule saved. ${violations.length} import${violations.length === 1 ? "" : "s"} violate it: ${violations.map((v) => `${v.from}:${v.line}`).join(", ")}.`
        : "Rule saved. No current imports violate it.",
      nextRequiredAction: violations.length ? "fix-queries" : undefined,
    };
  },
});
