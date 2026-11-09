import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import { actionErrorMessage, useActionMutation } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconPlayerPlay,
  IconMessageCircle,
  IconTool,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCell } from "@/lib/blueprint";
import { cn } from "@/lib/utils";
import type {
  ConflictReport,
  FixId,
  RehearsalResult,
  StepResult,
  TableDiff,
} from "@shared/rehearsal-types";

import { RowsTable } from "./BottomPanel";

const STEP_ICON = {
  ok: IconCircleCheck,
  fixed: IconTool,
  conflict: IconAlertTriangle,
  skipped: IconCircleDashed,
  error: IconCircleX,
} as const;

const STEP_COLOR = {
  ok: "text-ok",
  fixed: "text-fill",
  conflict: "text-conflict",
  skipped: "text-muted-foreground",
  error: "text-conflict",
} as const;

export function RehearsalView({
  projectId,
  rehearsalId,
  result,
  stale,
  empty,
}: {
  projectId: string;
  rehearsalId: string | null;
  result: RehearsalResult | null;
  stale: boolean;
  empty: React.ReactNode;
}) {
  const t = useT();
  const [replay, setReplay] = useState(0);
  if (!result) return <>{empty}</>;
  const conflictRows = new Map<string, Set<string>>();
  for (const c of result.conflicts) {
    const set = conflictRows.get(c.table) ?? new Set<string>();
    c.rowKeys.forEach((k) => set.add(k));
    conflictRows.set(c.table, set);
  }
  return (
    <div className="flex h-full min-h-0">
      <nav className="hidden w-72 shrink-0 overflow-y-auto border-e border-border p-4 lg:block">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("blueprint.rehearsal.steps")}
        </h2>
        <ol className="space-y-1">
          {result.steps.map((step) => (
            <StepRow key={step.index} step={step} />
          ))}
        </ol>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-8 p-6">
          {stale ? (
            <p className="rounded-md border border-fill/40 bg-fill/10 px-3 py-2 text-sm text-fill">
              {t("blueprint.rehearsal.stale")}
            </p>
          ) : null}
          <section>
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("blueprint.rehearsal.conflicts")}
            </h2>
            {result.conflicts.length ? (
              <div className="space-y-3">
                {[...result.conflicts]
                  .sort((a, b) => Number(Boolean(a.resolution)) - Number(Boolean(b.resolution)))
                  .map((conflict) => (
                  <ConflictCard key={conflict.key} conflict={conflict} projectId={projectId} />
                ))}
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-ok">
                <IconCircleCheck className="size-4" />
                {t("blueprint.rehearsal.noConflicts")}
              </p>
            )}
          </section>
          <section>
            <div className="mb-3 flex items-center">
              <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("blueprint.rehearsal.data")}
              </h2>
              {/* Replay animates rows; with none there is nothing to show. */}
              {result.tables.some((table) => table.rows.length) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ms-auto h-7 gap-1.5 text-xs"
                  onClick={() => setReplay((n) => n + 1)}
                >
                  <IconPlayerPlay className="size-3.5" />
                  {t("blueprint.rehearsal.replay")}
                </Button>
              ) : null}
            </div>
            <div className="space-y-6">
              {result.tables.map((table) => (
                <TableDiffView
                  key={`${rehearsalId}-${replay}-${table.table}`}
                  diff={table}
                  conflictKeys={conflictRows.get(table.table)}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: StepResult }) {
  const t = useT();
  const Icon = STEP_ICON[step.status];
  return (
    <li className="rounded-md px-2 py-1.5 text-xs hover:bg-accent/60">
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", STEP_COLOR[step.status])} />
        <div className="min-w-0">
          <p className="font-mono leading-4">{step.label}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t(`blueprint.rehearsal.${step.status}`)}
            {step.rowsAffected ? ` · ${t("blueprint.rehearsal.rows", { count: step.rowsAffected })}` : ""}
            {` · ${step.durationMs} ms`}
          </p>
          {step.fixDetail ? <p className="mt-0.5 text-[11px] text-fill">{step.fixDetail}</p> : null}
          {step.error ? <p className="mt-0.5 break-words text-[11px] text-conflict">{step.error}</p> : null}
        </div>
      </div>
    </li>
  );
}

function ConflictCard({ conflict, projectId }: { conflict: ConflictReport; projectId: string }) {
  const t = useT();
  const [fix, setFix] = useState<FixId | null>(conflict.resolution?.fix ?? null);
  const [value, setValue] = useState(conflict.resolution?.value ?? "");
  const resolve = useActionMutation("resolve-conflict", {
    onSuccess: (result) => toast.success(result.message, { duration: 6000 }),
    onError: (error) => toast.error(actionErrorMessage(error) ?? t("blueprint.rehearsal.fixFailed")),
  });
  const chosen = conflict.fixes.find((f) => f.id === fix);
  const resolved = Boolean(conflict.resolution);
  const columns = [
    ...conflict.columns,
    ...conflict.sampleColumns.filter((c) => !conflict.columns.includes(c)),
  ].slice(0, 6);
  return (
    <article
      className={cn(
        "rounded-lg border p-4",
        resolved ? "border-border bg-card" : "border-conflict/50 bg-conflict/5",
      )}
    >
      <header className="mb-3 flex items-start gap-2">
        {resolved ? (
          <IconTool className="mt-0.5 size-4 shrink-0 text-fill" />
        ) : (
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-conflict" />
        )}
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-medium", !resolved && "text-conflict")}>{conflict.message}</p>
          <p className="font-mono text-xs text-muted-foreground">{conflict.stepLabel}</p>
          {resolved ? (
            <p className="mt-1 text-xs text-fill">
              {t("blueprint.rehearsal.resolvedWith", {
                fix: conflict.fixes.find((f) => f.id === conflict.resolution?.fix)?.label ?? "",
              })}
              {conflict.fixResult ? ` · ${conflict.fixResult}` : null}
            </p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 text-xs"
          onClick={() =>
            sendToAgentChat({
              message: t("blueprint.rehearsal.askAgentPrompt", {
                kind: conflict.kind.replace("_", " "),
                table: conflict.table,
                message: conflict.message,
              }),
              submit: true,
              openSidebar: true,
            })
          }
        >
          <IconMessageCircle className="size-3.5 text-muted-foreground" />
          {t("blueprint.rehearsal.askAgent")}
        </Button>
      </header>
      <RowsTable columns={columns} rows={conflict.sampleRows} highlightColumns={conflict.columns} />
      {conflict.rowCount > conflict.sampleRows.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("blueprint.rehearsal.more", { count: conflict.rowCount - conflict.sampleRows.length })}
        </p>
      ) : null}
      <fieldset className="mt-3 grid gap-2 sm:grid-cols-3">
        {conflict.fixes.map((option) => (
          <label
            key={option.id}
            className={cn(
              "flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 text-sm transition-colors",
              fix === option.id ? "border-ring bg-accent" : "border-border hover:bg-accent/50",
            )}
          >
            <span className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                name={`fix-${conflict.key}`}
                value={option.id}
                checked={fix === option.id}
                onChange={() => setFix(option.id)}
                className="accent-current"
              />
              {option.label}
            </span>
            <span className="text-xs text-muted-foreground">{option.description}</span>
          </label>
        ))}
      </fieldset>
      <div className="mt-3 flex items-center gap-2">
        {chosen?.needsValue ? (
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("blueprint.rehearsal.value")}
            aria-label={t("blueprint.rehearsal.value")}
            className="h-8 max-w-64 font-mono text-xs"
          />
        ) : null}
        <Button
          size="sm"
          className="h-8"
          disabled={!fix || resolve.isPending || (chosen?.needsValue && !value.trim())}
          onClick={() =>
            fix &&
            resolve.mutate({
              projectId,
              conflict: conflict.key,
              fix,
              ...(chosen?.needsValue ? { value: value.trim() } : {}),
            })
          }
        >
          {resolve.isPending ? t("blueprint.rehearsal.applying") : t("blueprint.rehearsal.applyFix")}
        </Button>
      </div>
    </article>
  );
}

/** Shows rows as they were, then transforms them into the migrated rows. */
function TableDiffView({ diff, conflictKeys }: { diff: TableDiff; conflictKeys?: Set<string> | undefined }) {
  const t = useT();
  const [phase, setPhase] = useState<"before" | "after">("before");
  useEffect(() => {
    const timer = setTimeout(() => setPhase("after"), 700);
    return () => clearTimeout(timer);
  }, []);
  const after = phase === "after";
  const rows = diff.rows.filter((row) => after || row.status !== "added");
  // Wide tables: new columns sit right after the first one, where they show.
  const columns = diff.isNew
    ? diff.columns
    : [
        ...diff.columns.slice(0, 1),
        ...diff.newColumns.filter((c) => c !== diff.columns[0]),
        ...diff.columns.slice(1).filter((c) => !diff.newColumns.includes(c)),
      ];
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-mono text-sm font-semibold">{diff.table}</h3>
        {diff.isNew ? (
          <span className="rounded bg-ghost/15 px-1.5 py-0.5 text-[10px] font-medium text-ghost">
            {t("blueprint.rehearsal.newTableBadge")}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {[
            diff.counts.changed ? t("blueprint.rehearsal.changed", { count: diff.counts.changed }) : null,
            diff.counts.added ? t("blueprint.rehearsal.added", { count: diff.counts.added }) : null,
            diff.counts.deleted ? t("blueprint.rehearsal.deleted", { count: diff.counts.deleted }) : null,
            !diff.isNew && diff.newColumns.length
              ? t("blueprint.rehearsal.newColumns", { columns: diff.newColumns.join(", ") })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {diff.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("blueprint.rehearsal.noRows")}</p>
      ) : (
      <div className="max-h-96 overflow-auto rounded-md border border-border">
        <table className="w-full font-mono text-[11.5px]">
          <thead className="sticky top-0 z-10 bg-muted/80 text-muted-foreground backdrop-blur">
            <tr>
              {columns.map((c) => {
                const fresh = diff.newColumns.includes(c) && !diff.isNew;
                return (
                  <th
                    key={c}
                    className={cn(
                      "whitespace-nowrap px-2 py-1 text-start font-medium transition-colors duration-500",
                      fresh && (after ? "text-ghost" : "text-transparent"),
                    )}
                  >
                    {c}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const deleted = row.status === "deleted";
              const conflicted = conflictKeys?.has(row.key);
              const delay = { animationDelay: `${Math.min(index, 40) * 35}ms` };
              return (
                <tr
                  key={row.key}
                  className={cn(
                    "border-t border-border transition-[opacity,background-color] duration-500",
                    conflicted && "shadow-[inset_3px_0_0_hsl(var(--bp-conflict))]",
                    after && deleted && "bg-conflict/10 text-conflict line-through opacity-60",
                    after && row.status === "added" && "bp-row-in bg-ok/10",
                  )}
                  style={after && row.status === "added" ? delay : undefined}
                >
                  {columns.map((c) => {
                    const source = after && !deleted ? row.after : row.before;
                    const fresh = diff.newColumns.includes(c) && !diff.isNew;
                    const changed = after && row.status === "changed" && row.changed.includes(c);
                    const value = source ? source[c] : undefined;
                    return (
                      <td
                        key={c}
                        className={cn(
                          "max-w-56 truncate whitespace-nowrap px-2 py-1",
                          changed && "bp-cell-changed",
                          value === null && "text-muted-foreground/60",
                          fresh && !after && "text-transparent",
                        )}
                        style={changed ? delay : undefined}
                        title={
                          changed && row.before && c in row.before
                            ? `${formatCell(row.before[c])} → ${formatCell(value)}`
                            : undefined
                        }
                      >
                        {fresh && !after ? (
                          "·"
                        ) : changed && !fresh && row.before ? (
                          <>
                            <span className="me-1.5 text-muted-foreground line-through">
                              {formatCell(row.before[c])}
                            </span>
                            {formatCell(value)}
                          </>
                        ) : (
                          formatCell(value)
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
