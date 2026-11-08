import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { IconChevronDown, IconChevronUp, IconCopy } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCell } from "@/lib/blueprint";
import { cn } from "@/lib/utils";
import type { CodeAnalysis, CodeImpact } from "@shared/code-types";
import type { RehearsalResult } from "@shared/rehearsal-types";

export type BottomTab = "data" | "impact" | "sql" | "rehearsal";

export function BottomPanel({
  projectId,
  table,
  sql,
  result,
  stale,
  tab,
  onTab,
  open,
  onOpenChange,
  impacts,
  code,
  onSelectModule,
}: {
  impacts: CodeImpact[];
  code: CodeAnalysis | null;
  onSelectModule: (path: string) => void;
  projectId: string;
  table: string | null;
  sql: string;
  result: RehearsalResult | null;
  stale: boolean;
  tab: BottomTab;
  onTab: (tab: BottomTab) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const tabs: { id: BottomTab; label: string }[] = [
    { id: "data", label: t("blueprint.bottom.data") },
    {
      id: "impact",
      label: `${t("blueprint.bottom.impact")}${impacts.some((i) => i.severity === "breaks") ? ` (${impacts.filter((i) => i.severity === "breaks").length})` : ""}`,
    },
    { id: "sql", label: t("blueprint.bottom.sql") },
    { id: "rehearsal", label: t("blueprint.bottom.rehearsal") },
  ];
  return (
    <section
      className={cn(
        "flex shrink-0 flex-col border-t border-border bg-background transition-[height] duration-200",
        open ? "h-72" : "h-10",
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 px-2" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={open && tab === item.id}
            onClick={() => {
              onTab(item.id);
              onOpenChange(true);
            }}
            className={cn(
              "h-7 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
              open && tab === item.id && "bg-secondary text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto size-7"
          aria-label={open ? t("blueprint.bottom.collapse") : t("blueprint.bottom.expand")}
          onClick={() => onOpenChange(!open)}
        >
          {open ? <IconChevronDown className="size-4" /> : <IconChevronUp className="size-4" />}
        </Button>
      </div>
      {open ? (
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          {tab === "data" ? (
            table ? (
              <DataPreview projectId={projectId} table={table} />
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">{t("blueprint.bottom.selectTable")}</p>
            )
          ) : tab === "impact" ? (
            <ImpactList impacts={impacts} code={code} onSelectModule={onSelectModule} />
          ) : tab === "sql" ? (
            <SqlView sql={sql} />
          ) : (
            <RehearsalSummary projectId={projectId} result={result} stale={stale} />
          )}
        </div>
      ) : null}
    </section>
  );
}

function DataPreview({ projectId, table }: { projectId: string; table: string }) {
  const t = useT();
  const { data, isPending } = useActionQuery("preview-table-data", { projectId, table, limit: 50 });
  if (isPending || !data) {
    return (
      <div className="space-y-1.5 pt-1">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div>
      <p className="mb-1.5 text-xs text-muted-foreground">
        <span className="font-mono text-foreground">{table}</span>{" "}
        {t("blueprint.bottom.rowsOf", { shown: data.rows.length, total: data.total })}
      </p>
      <RowsTable columns={data.columns} rows={data.rows} />
    </div>
  );
}

export function RowsTable({
  columns,
  rows,
  highlightColumns,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  highlightColumns?: string[];
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full font-mono text-[11.5px]">
        <thead className="sticky top-0 bg-muted/70 text-muted-foreground backdrop-blur">
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                className={cn(
                  "whitespace-nowrap px-2 py-1 text-start font-medium",
                  highlightColumns?.includes(c) && "text-conflict",
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border">
              {columns.map((c) => (
                <td
                  key={c}
                  className={cn(
                    "max-w-56 truncate whitespace-nowrap px-2 py-1",
                    row[c] === null && "text-muted-foreground/60",
                    highlightColumns?.includes(c) && "text-conflict",
                  )}
                >
                  {formatCell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SqlView({ sql }: { sql: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        className="absolute end-2 top-2 h-7 gap-1.5 text-xs"
        onClick={() => {
          void navigator.clipboard.writeText(sql).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <IconCopy className="size-3.5" />
        {copied ? t("blueprint.bottom.copied") : t("blueprint.bottom.copy")}
      </Button>
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11.5px] leading-5">
        {sql}
      </pre>
    </div>
  );
}

function RehearsalSummary({
  projectId,
  result,
  stale,
}: {
  projectId: string;
  result: RehearsalResult | null;
  stale: boolean;
}) {
  const t = useT();
  if (!result) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{t("blueprint.bottom.noRehearsal")}</p>;
  }
  return (
    <div className="space-y-2 pt-1">
      {stale ? <p className="text-xs text-fill">{t("blueprint.rehearsal.stale")}</p> : null}
      <div className="flex flex-wrap gap-2">
        {result.tables.map((table) => (
          <div key={table.table} className="rounded-md border border-border px-2.5 py-1.5 text-xs">
            <span className="font-mono font-medium">{table.table}</span>
            <span className="ms-2 text-muted-foreground">
              {[
                table.counts.changed ? t("blueprint.rehearsal.changed", { count: table.counts.changed }) : null,
                table.counts.added ? t("blueprint.rehearsal.added", { count: table.counts.added }) : null,
                table.counts.deleted ? t("blueprint.rehearsal.deleted", { count: table.counts.deleted }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        ))}
      </div>
      <ul className="space-y-0.5 text-xs">
        {result.conflicts.map((c) => (
          <li key={c.key} className={cn(c.resolution ? "text-muted-foreground" : "text-conflict")}>
            {c.message}
          </li>
        ))}
      </ul>
      <Button asChild size="sm" variant="outline" className="h-7 text-xs">
        <Link to={`/projects/${encodeURIComponent(projectId)}/rehearse`}>{t("blueprint.bottom.openRehearsal")}</Link>
      </Button>
    </div>
  );
}

function ImpactList({
  impacts,
  code,
  onSelectModule,
}: {
  impacts: CodeImpact[];
  code: CodeAnalysis | null;
  onSelectModule: (path: string) => void;
}) {
  const t = useT();
  if (!impacts.length) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{t("blueprint.code.impactEmpty")}</p>;
  }
  const sorted = [...impacts].sort(
    (a, b) => Number(a.severity === "review") - Number(b.severity === "review") || a.module.localeCompare(b.module) || a.line - b.line,
  );
  return (
    <div className="space-y-1 pt-1">
      {code?.approximate ? <p className="text-xs text-muted-foreground">{t("blueprint.code.approximate")}</p> : null}
      <table className="w-full text-xs">
        <tbody>
          {sorted.map((impact) => (
            <tr key={impact.usageId + impact.itemId} className="border-t border-border align-top">
              <td className="py-1 pe-2">
                <span
                  className={cn(
                    "rounded px-1 py-px text-[10px] font-medium uppercase",
                    impact.severity === "breaks" ? "bg-conflict/15 text-conflict" : "bg-ghost/15 text-ghost",
                  )}
                >
                  {t(`blueprint.code.${impact.severity}`)}
                </span>
              </td>
              <td className="whitespace-nowrap py-1 pe-3 font-mono">
                <button type="button" className="hover:underline" onClick={() => onSelectModule(impact.module)}>
                  {impact.module}:{impact.line}
                </button>
              </td>
              <td className="py-1 pe-3 font-mono text-muted-foreground">{impact.function}()</td>
              <td className="py-1">{impact.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
