import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import {
  IconAlertTriangle,
  IconBrandGithub,
  IconCircleCheck,
  IconCircleDashed,
  IconExternalLink,
  IconFileDiff,
  IconLoader2,
  IconPlayerPlay,
  IconPlayerStop,
  IconMessageCircle,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorCode } from "@/lib/blueprint";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/routes/projects.$projectId";

interface FilePatch {
  path: string;
  lines: string[];
}

function splitPatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let current: FilePatch | null = null;
  for (const line of patch.split("\n")) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      current = { path: header[2]!, lines: [] };
      files.push(current);
      continue;
    }
    if (!current || /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(line)) continue;
    current.lines.push(line);
  }
  return files;
}

export default function ProjectShipRoute() {
  const t = useT();
  const { projectId, rehearsal } = useWorkspace();
  const status = useActionQuery("get-ship-status", { projectId });
  const [repo, setRepo] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const runTests = useActionMutation("run-tests", {
    onSuccess: (result) => toast[result.status === "passed" ? "success" : "warning"](result.message, { duration: 7000 }),
    onError: (error) => {
      const message = actionErrorMessage(error) ?? t("blueprint.ship.testsFailed");
      if (errorCode(error) === "tests_cancelled") toast(message);
      else toast.error(message);
    },
  });
  // The agent can start a run too, so progress is read from the server.
  const testProgress = useActionQuery(
    "get-test-progress",
    { projectId },
    { refetchInterval: (query) => (runTests.isPending || query.state.data?.running ? 1500 : 10000) },
  );
  const running = runTests.isPending || Boolean(testProgress.data?.running);
  const cancelTests = useActionMutation("cancel-tests", {
    onError: (error) => toast.error(actionErrorMessage(error) ?? t("blueprint.ship.cancelFailed")),
  });
  // A run the agent started ends without this screen's mutation settling.
  const wasRunning = useWasTrue(Boolean(testProgress.data?.running));
  useEffect(() => {
    if (wasRunning && !testProgress.data?.running) void status.refetch();
  }, [wasRunning, testProgress.data?.running, status]);
  const createPr = useActionMutation("create-pr", {
    onSuccess: (result) => toast.success(result.message, { duration: 10000 }),
    onError: (error) => {
      const message = actionErrorMessage(error) ?? t("blueprint.ship.prFailed");
      if (errorCode(error) === "github_token_missing") toast.error(message, { duration: 10000 });
      else toast.error(message);
    },
  });
  const patches = useMemo(() => splitPatch(status.data?.patch ?? ""), [status.data?.patch]);

  if (status.isPending || !status.data) {
    return (
      <div className="grid gap-4 p-6 lg:grid-cols-[20rem_1fr]">
        <Skeleton className="h-80 rounded-lg" />
        <Skeleton className="h-[32rem] rounded-lg" />
      </div>
    );
  }
  const data = status.data;
  const test = data.test;
  const failing = test?.cases.filter((c) => c.status === "failed") ?? [];
  const target = repo.trim() || data.githubRepo || "";

  const checks = [
    {
      ok: Boolean(rehearsal && !rehearsal.stale && rehearsal.status === "passed"),
      label: t("blueprint.ship.checkRehearsal"),
    },
    {
      ok: Boolean(test && (test.status === "passed" || test.status === "none") && data.ready),
      label: test?.status === "none" ? t("blueprint.ship.checkNoTests") : t("blueprint.ship.checkTests"),
    },
    { ok: Boolean(data.pullRequest), label: t("blueprint.ship.checkPr") },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
      <aside className="w-full shrink-0 space-y-6 border-b border-border p-5 md:w-80 md:overflow-y-auto md:border-b-0 md:border-e">
        <ol className="space-y-2">
          {checks.map((check) => (
            <li key={check.label} className="flex items-center gap-2 text-sm">
              {check.ok ? (
                <IconCircleCheck className="size-4 text-ok" />
              ) : (
                <IconCircleDashed className="size-4 text-muted-foreground" />
              )}
              <span className={cn(!check.ok && "text-muted-foreground")}>{check.label}</span>
            </li>
          ))}
        </ol>
        {data.blockers.length && !data.pullRequest ? (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {data.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}

        <div className="space-y-2">
          <Button
            className="w-full gap-1.5"
            variant={(test?.status === "passed" || test?.status === "none") && data.ready ? "outline" : "default"}
            disabled={running}
            onClick={() => runTests.mutate({ projectId })}
          >
            {running ? <IconLoader2 className="size-4 animate-spin" /> : <IconPlayerPlay className="size-4" />}
            {running ? t("blueprint.ship.running") : t("blueprint.ship.runTests")}
          </Button>
          {running ? (
            <Button
              variant="outline"
              className="w-full gap-1.5"
              disabled={cancelTests.isPending || testProgress.data?.cancelling}
              onClick={() => cancelTests.mutate({ projectId })}
            >
              <IconPlayerStop className="size-4" />
              {testProgress.data?.cancelling ? t("blueprint.ship.cancelling") : t("blueprint.ship.cancelRun")}
            </Button>
          ) : null}
          {failing.length ? (
            <Button
              variant="outline"
              className="w-full gap-1.5"
              onClick={() =>
                sendToAgentChat({
                  message: t("blueprint.ship.fixTestsPrompt", { count: failing.length }),
                  submit: true,
                  openSidebar: true,
                })
              }
            >
              <IconMessageCircle className="size-4 text-muted-foreground" />
              {t("blueprint.ship.fixTests")}
            </Button>
          ) : null}
        </div>

        <div className="space-y-2 border-t border-border pt-5">
          {data.pullRequest ? (
            <a
              href={data.pullRequest.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm font-medium text-ok"
            >
              <IconBrandGithub className="size-4" />
              {t("blueprint.ship.prOpened", { number: data.pullRequest.number })}
              <IconExternalLink className="ms-auto size-3.5" />
            </a>
          ) : (
            <>
              <label className="text-xs font-medium" htmlFor="pr-repo">
                {t("blueprint.ship.repo")}
              </label>
              <Input
                id="pr-repo"
                value={repo}
                placeholder={data.githubRepo ?? "owner/name"}
                onChange={(e) => setRepo(e.target.value)}
                className="h-8 font-mono text-xs"
              />
              <Button
                className="w-full gap-1.5"
                disabled={!data.ready || !target || createPr.isPending}
                onClick={() => createPr.mutate({ projectId, repo: target })}
              >
                {createPr.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconBrandGithub className="size-4" />}
                {createPr.isPending ? t("blueprint.ship.creating") : t("blueprint.ship.createPr")}
              </Button>
            </>
          )}
        </div>
      </aside>

      <div className="min-w-0 flex-1 md:overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-8 p-5 md:p-6">
          <section>
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("blueprint.ship.tests")}
            </h2>
            {running ? (
              <TestProgress phase={testProgress.data?.phase ?? null} steps={testProgress.data?.steps ?? []} startedAt={testProgress.data?.startedAt ?? null} />
            ) : test ? (
              <TestResults test={test} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("blueprint.ship.noTests")}</p>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("blueprint.ship.diff", { count: data.files.length })}
            </h2>
            {data.files.length ? (
              <div className="space-y-2">
                {data.files.map((file) => {
                  const patch = patches.find((p) => p.path === file.path);
                  const expanded = open === file.path;
                  return (
                    <div key={file.path} className="overflow-hidden rounded-md border border-border">
                      <button
                        type="button"
                        onClick={() => setOpen(expanded ? null : file.path)}
                        className="flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-start text-sm hover:bg-muted/70"
                      >
                        <IconFileDiff className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate font-mono text-xs">{file.path}</span>
                        {file.origin ? (
                          <span
                            className={cn(
                              "shrink-0 rounded px-1 text-[10px] font-medium uppercase",
                              file.origin === "generated" ? "bg-muted text-muted-foreground" : "bg-foreground/10 text-foreground",
                            )}
                          >
                            {t(`blueprint.ship.origin.${file.origin}`)}
                          </span>
                        ) : null}
                        <span className="ms-auto shrink-0 font-mono text-xs">
                          <span className="text-ok">+{file.additions}</span>{" "}
                          <span className="text-conflict">−{file.deletions}</span>
                        </span>
                      </button>
                      {file.summary ? <p className="border-t border-border px-3 py-1 text-xs text-muted-foreground">{file.summary}</p> : null}
                      {expanded && patch ? (
                        <pre className="max-h-[32rem] overflow-auto border-t border-border font-mono text-[11.5px] leading-5">
                          {patch.lines.slice(0, 1500).map((line, i) => (
                            <div
                              key={i}
                              className={cn(
                                "px-3",
                                line.startsWith("+") && "bg-ok/10 text-ok",
                                line.startsWith("-") && "bg-conflict/10 text-conflict",
                                line.startsWith("@@") && "bg-muted/60 text-muted-foreground",
                              )}
                            >
                              {line || " "}
                            </div>
                          ))}
                          {patch.lines.length > 1500 ? (
                            <div className="px-3 text-muted-foreground">{t("blueprint.ship.more", { count: patch.lines.length - 1500 })}</div>
                          ) : null}
                        </pre>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("blueprint.ship.noDiff")}</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** True once `value` has been true, until the component unmounts. */
function useWasTrue(value: boolean) {
  const [was, setWas] = useState(false);
  useEffect(() => {
    if (value) setWas(true);
  }, [value]);
  return was;
}

function TestProgress({ phase, steps, startedAt }: { phase: string | null; steps: string[]; startedAt: string | null }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const done = steps.slice(0, -1);
  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <IconLoader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{phase ?? t("blueprint.ship.running")}</span>
        {startedAt ? (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {duration(Math.max(0, now - Date.parse(startedAt)))}
          </span>
        ) : null}
      </div>
      {done.length ? (
        <ol className="space-y-1 text-xs text-muted-foreground">
          {done.map((step, i) => (
            <li key={`${i}-${step}`} className="flex items-center gap-2">
              <IconCircleCheck className="size-3.5 shrink-0" />
              <span className="truncate">{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("blueprint.ship.progressHint")}</p>
    </div>
  );
}

type TestCaseView = { name: string; file: string; status: string; message?: string | undefined };

const duration = (ms: number) =>
  ms < 1000
    ? `${ms} ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
      : `${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)} s`;

/**
 * Failures first, with their errors. Checks that also fail on the untouched
 * code, and the passing ones, fold away: a real repo has hundreds.
 */
function TestResults({ test }: { test: { status: string; passed: number; total: number; durationMs: number; command: string; cases: TestCaseView[]; output: string } }) {
  const t = useT();
  if (test.status === "none" || (test.status === "error" && !test.cases.length)) {
    return <p className="text-sm text-muted-foreground">{test.output}</p>;
  }
  const failed = test.cases.filter((c) => c.status === "failed");
  const known = test.cases.filter((c) => c.status === "preexisting");
  const passed = test.cases.filter((c) => c.status === "passed" || c.status === "skipped");
  const commands = test.command.split(" && ").filter(Boolean);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className={cn("text-sm font-medium", test.status === "passed" ? "text-ok" : "text-conflict")}>
          {t("blueprint.ship.testSummary", { passed: test.passed, total: test.total, duration: duration(test.durationMs) })}
        </p>
        {commands.length > 1 ? (
          <details className="group text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">{t("blueprint.ship.suites", { count: commands.length })}</summary>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
              {commands.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">{test.command}</span>
        )}
      </div>
      {failed.length ? <CaseList cases={failed} /> : null}
      {known.length ? (
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer select-none px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            {t("blueprint.ship.preexistingGroup", { count: known.length })}
          </summary>
          <CaseList cases={known} flush />
        </details>
      ) : null}
      {passed.length ? (
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer select-none px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            <IconCircleCheck className="me-1.5 inline size-3.5 text-ok" />
            {t("blueprint.ship.passedGroup", { count: passed.length })}
          </summary>
          <CaseList cases={passed} flush />
        </details>
      ) : null}
    </div>
  );
}

const CASE_LIMIT = 300;

function CaseList({ cases, flush }: { cases: TestCaseView[]; flush?: boolean }) {
  const t = useT();
  return (
    <ul className={cn("divide-y divide-border text-sm", flush ? "border-t border-border" : "rounded-md border border-border")}>
      {cases.slice(0, CASE_LIMIT).map((c) => (
        <li key={`${c.file}:${c.name}`} className="px-3 py-1.5">
          <div className="flex items-center gap-2">
            {c.status === "passed" ? (
              <IconCircleCheck className="size-3.5 shrink-0 text-ok" />
            ) : c.status === "failed" ? (
              <IconAlertTriangle className="size-3.5 shrink-0 text-conflict" />
            ) : (
              <IconCircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 truncate" title={c.name}>{c.name}</span>
            <span className="ms-auto max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={c.file}>
              {c.file}
            </span>
          </div>
          {c.message && c.status === "failed" ? (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-conflict/5 p-2 font-mono text-[11px] text-conflict">
              {c.message}
            </pre>
          ) : null}
        </li>
      ))}
      {cases.length > CASE_LIMIT ? (
        <li className="px-3 py-1.5 text-xs text-muted-foreground">{t("blueprint.ship.moreCases", { count: cases.length - CASE_LIMIT })}</li>
      ) : null}
    </ul>
  );
}
