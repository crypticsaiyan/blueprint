import { and, desc, eq, ne } from "drizzle-orm";

import { getDb, schema } from "../db/index.js";
import type { ChangesetRow } from "./projects.js";

/**
 * What blocks shipping. Tests count as fresh only if they ran after the last
 * change to the plan, the code, or the rules.
 */
export async function shipReadiness(projectId: string, changeset: ChangesetRow) {
  const db = getDb();
  const [rehearsal] = await db
    .select({ status: schema.rehearsals.status, createdAt: schema.rehearsals.createdAt })
    .from(schema.rehearsals)
    .where(eq(schema.rehearsals.changesetId, changeset.id))
    .orderBy(desc(schema.rehearsals.createdAt))
    .limit(1);
  const [test] = await db
    .select()
    .from(schema.testRuns)
    .where(eq(schema.testRuns.changesetId, changeset.id))
    .orderBy(desc(schema.testRuns.createdAt))
    .limit(1);
  const [edit] = await db
    .select({ createdAt: schema.codeEdits.createdAt })
    .from(schema.codeEdits)
    .where(and(eq(schema.codeEdits.changesetId, changeset.id), ne(schema.codeEdits.origin, "generated")))
    .orderBy(desc(schema.codeEdits.createdAt))
    .limit(1);
  const [rule] = await db
    .select({ createdAt: schema.rules.createdAt })
    .from(schema.rules)
    .where(eq(schema.rules.projectId, projectId))
    .orderBy(desc(schema.rules.createdAt))
    .limit(1);
  const [items] = await db
    .select({ id: schema.changeItems.id })
    .from(schema.changeItems)
    .where(and(eq(schema.changeItems.changesetId, changeset.id), ne(schema.changeItems.status, "rejected")))
    .limit(1);
  const lastChange = [changeset.updatedAt, edit?.createdAt, rule?.createdAt].filter(Boolean).sort().pop()!;
  const hasPlan = Boolean(items);
  const rehearsalOk = !hasPlan || (rehearsal?.status === "passed" && rehearsal.createdAt >= changeset.updatedAt);
  // A repo with nothing to run ships on the rehearsal alone.
  const testsOk = (test?.status === "passed" || test?.status === "none") && test.createdAt >= lastChange;
  const blockers: string[] = [];
  if (!hasPlan && !edit && !rule) blockers.push("Nothing to ship yet.");
  if (!rehearsalOk) blockers.push(rehearsal ? "Rehearse again: the last rehearsal did not pass or the plan changed." : "Rehearse the migration first.");
  if (!testsOk) blockers.push(test ? "Run the tests again: they failed or the code changed since." : "Run the tests first.");
  return { rehearsal: rehearsal ?? null, test: test ?? null, rehearsalOk, testsOk, ready: blockers.length === 0, blockers };
}
