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
  IconSparkles,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
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
    onError: (error) => toast.error(actionErrorMessage(error) ?? t("blueprint.ship.testsFailed")),
  });
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
    { ok: Boolean(test && test.status === "passed" && data.ready), label: t("blueprint.ship.checkTests") },
    { ok: Boolean(data.pullRequest), label: t("blueprint.ship.checkPr") },
  ];

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-80 shrink-0 space-y-6 overflow-y-auto border-e border-border p-5">
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
            variant={test?.status === "passed" && data.ready ? "outline" : "default"}
            disabled={runTests.isPending}
            onClick={() => runTests.mutate({ projectId })}
          >
            {runTests.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconPlayerPlay className="size-4" />}
            {runTests.isPending ? t("blueprint.ship.running") : t("blueprint.ship.runTests")}
          </Button>
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
              <IconSparkles className="size-4 text-ghost" />
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

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-8 p-6">
          <section>
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("blueprint.ship.tests")}
            </h2>
            {test ? (
              <div className="space-y-2">
                <p className={cn("text-sm font-medium", test.status === "passed" ? "text-ok" : "text-conflict")}>
                  {t("blueprint.ship.testSummary", { passed: test.passed, total: test.total, ms: test.durationMs })}
                  <span className="ms-2 font-mono text-xs font-normal text-muted-foreground">{test.command}</span>
                </p>
                <ul className="divide-y divide-border rounded-md border border-border text-sm">
                  {test.cases.map((c) => (
                    <li key={`${c.file}:${c.name}`} className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        {c.status === "passed" ? (
                          <IconCircleCheck className="size-3.5 shrink-0 text-ok" />
                        ) : c.status === "failed" ? (
                          <IconAlertTriangle className="size-3.5 shrink-0 text-conflict" />
                        ) : (
                          <IconCircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{c.name}</span>
                        <span className="ms-auto shrink-0 font-mono text-[11px] text-muted-foreground">{c.file}</span>
                      </div>
                      {c.message ? (
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-conflict/5 p-2 font-mono text-[11px] text-conflict">
                          {c.message}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
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
                              file.origin === "generated" ? "bg-ghost/15 text-ghost" : "bg-fill/15 text-fill",
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
