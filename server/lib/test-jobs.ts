import { AsyncLocalStorage } from "node:async_hooks";

import { fail } from "@agent-native/core/action";

// A test run can take minutes on a real repo (install, suites, typecheck, a
// baseline run). One runs per changeset at a time; while it does, its phase
// is readable and it can be cancelled, and nothing else writes the working
// copy (the baseline run stashes the changeset's edits).

export interface TestJob {
  changesetId: string;
  phase: string;
  startedAt: string;
  /** Commands run so far, newest last, for the progress view. */
  steps: string[];
  controller: AbortController;
}

const jobs = new Map<string, TestJob>();
const context = new AsyncLocalStorage<TestJob>();

export class TestsCancelledError extends Error {
  constructor() {
    super("The test run was cancelled.");
  }
}

/** Runs `fn` as the changeset's test job; refuses a second one. */
export async function withTestJob<T>(changesetId: string, fn: (job: TestJob) => Promise<T>): Promise<T> {
  if (jobs.has(changesetId)) {
    fail("Tests are already running for this changeset. Wait for them, or cancel them first.", {
      errorCode: "tests_running",
      statusCode: 409,
    });
  }
  const job: TestJob = { changesetId, phase: "Starting", startedAt: new Date().toISOString(), steps: [], controller: new AbortController() };
  jobs.set(changesetId, job);
  try {
    return await context.run(job, () => fn(job));
  } finally {
    jobs.delete(changesetId);
  }
}

/** Names what the current job is doing; a no-op outside a job. */
export function progress(phase: string) {
  const job = context.getStore();
  if (!job) return;
  job.phase = phase;
  job.steps = [...job.steps, phase].slice(-12);
}

/** The current job's abort signal, for child processes. */
export const currentSignal = (): AbortSignal | undefined => context.getStore()?.controller.signal;

export function throwIfCancelled() {
  if (context.getStore()?.controller.signal.aborted) throw new TestsCancelledError();
}

export function testJob(changesetId: string) {
  const job = jobs.get(changesetId);
  return job ? { phase: job.phase, startedAt: job.startedAt, steps: job.steps, cancelling: job.controller.signal.aborted } : null;
}

export function cancelTestJob(changesetId: string): boolean {
  const job = jobs.get(changesetId);
  if (!job) return false;
  job.phase = "Cancelling";
  job.controller.abort();
  return true;
}

/** For actions that write the working copy: wait out a running test job. */
export function assertWorkspaceFree(changesetId: string) {
  if (jobs.has(changesetId)) {
    fail("Tests are running in this changeset's working copy. Wait for them to finish, or cancel them, then try again.", {
      errorCode: "tests_running",
      statusCode: 409,
    });
  }
}
