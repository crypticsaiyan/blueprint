// Where a project's open changeset stands in plan, rehearse, ship. The
// dashboard, the sidebar and the project header all read it the same way.

export type Stage = "empty" | "planning" | "conflicts" | "failed" | "rehearsed" | "tests_failed" | "ready" | "pr";

export interface StageInput {
  /** Non-rejected change items. */
  changes: number;
  rehearsal: { status: string; stale: boolean } | null;
  test: { status: string; stale: boolean } | null;
  pullRequest: { number: number; url: string } | null;
}

export function projectStage({ changes, rehearsal, test, pullRequest }: StageInput): Stage {
  if (pullRequest) return "pr";
  if (!changes) return "empty";
  if (!rehearsal || rehearsal.stale) return "planning";
  if (rehearsal.status === "conflicts") return "conflicts";
  if (rehearsal.status !== "passed") return "failed";
  if (!test || test.stale) return "rehearsed";
  return test.status === "passed" || test.status === "none" ? "ready" : "tests_failed";
}

/** Tone for status dots and pills. */
export const STAGE_TONE: Record<Stage, "muted" | "neutral" | "conflict" | "ok" | "fill"> = {
  empty: "muted",
  planning: "neutral",
  conflicts: "conflict",
  failed: "conflict",
  rehearsed: "neutral",
  tests_failed: "conflict",
  ready: "ok",
  pr: "ok",
};
