import { useT } from "@agent-native/core/client/i18n";
import { IconKey, IconLock, IconPlus, IconTable } from "@tabler/icons-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { cn } from "@/lib/utils";
import type { ProjectedTable } from "@shared/changes";

export type TableNodeData = {
  table: ProjectedTable;
  selected: boolean;
  affected: boolean;
  conflict: boolean;
  /** Large schemas: show only key, proposed and constrained columns. */
  compact: boolean;
  /** Draws attention when a hovered or selected node relates to this table. */
  dimmed: boolean;
};
export type TableFlowNode = Node<TableNodeData, "table">;

/** Postgres type names as people write them: timestamptz(3), varchar(255). */
export function shortType(type: string) {
  return type
    .replace(/^timestamp(\(\d+\))? with time zone/, "timestamptz$1")
    .replace(/^timestamp(\(\d+\))? without time zone/, "timestamp$1")
    .replace(/^time(\(\d+\))? with time zone/, "timetz$1")
    .replace(/^time(\(\d+\))? without time zone/, "time$1")
    .replace(/^character varying/, "varchar")
    .replace(/^double precision/, "float8");
}

export const TableNode = memo(function TableNode({ data }: NodeProps<TableFlowNode>) {
  const t = useT();
  const { table, selected, affected, conflict, compact, dimmed } = data;
  const ghost = Boolean(table.ghost);
  const shown =
    compact && !selected && !ghost
      ? table.columns.filter((c) => c.isPrimaryKey || c.ghost || c.ghostConstraints?.length)
      : table.columns;
  const hidden = table.columns.length - shown.length;
  return (
    <div
      className={cn(
        "w-60 rounded-lg border bg-card text-card-foreground shadow-sm transition-[box-shadow,opacity]",
        ghost ? "border-dashed border-ghost bg-ghost/5" : "border-border",
        selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        conflict ? "bp-glow-conflict" : affected && "bp-glow",
        dimmed && "opacity-40",
      )}
    >
      <Handle id="fk-out" type="source" position={Position.Left} aria-label={`${table.name} belongs to`} />
      <Handle
        id="code"
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!size-1.5 !border-0 !bg-transparent"
      />
      <div
        className={cn(
          "flex items-center gap-2 border-b px-3 py-2",
          ghost ? "border-dashed border-ghost/60" : "border-border",
        )}
      >
        <IconTable
          className={cn("size-4 shrink-0", ghost ? "text-ghost" : "text-muted-foreground")}
          strokeWidth={1.8}
        />
        <span className={cn("truncate font-mono text-[13px] font-semibold", ghost && "text-ghost")}>
          {table.name}
        </span>
        <span className="ms-auto flex shrink-0 items-center gap-1">
          {table.backfills.length > 0 ? (
            <span className="rounded bg-fill/15 px-1.5 py-0.5 text-[10px] font-medium text-fill">
              {t("blueprint.canvas.backfill")}
            </span>
          ) : null}
          {ghost ? (
            <span className="rounded bg-ghost/15 px-1.5 py-0.5 text-[10px] font-medium text-ghost">
              {t("blueprint.canvas.newTable")}
            </span>
          ) : (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {t("blueprint.canvas.rows", { count: table.rowCount ?? 0 })}
            </span>
          )}
          {table.ghost?.locked ? <IconLock className="size-3 text-ghost" /> : null}
        </span>
      </div>
      <ul className="py-1">
        {shown.map((column) => {
          const proposed = Boolean(column.ghost) && !ghost;
          return (
            <li
              key={column.name}
              className={cn(
                "flex items-center gap-1.5 px-3 py-[3px] font-mono text-[11.5px]",
                proposed && "mx-1 rounded border border-dashed border-ghost/70 bg-ghost/5 px-2 text-ghost",
              )}
            >
              {column.isPrimaryKey ? (
                <IconKey className="size-3 shrink-0 text-fill" strokeWidth={2} />
              ) : proposed ? (
                <IconPlus className="size-3 shrink-0" strokeWidth={2.2} />
              ) : (
                <span className="size-3 shrink-0" />
              )}
              <span className="truncate">{column.name}</span>
              <span className={cn("ms-auto truncate ps-2", proposed ? "text-ghost/80" : "text-muted-foreground")}>
                {shortType(column.type)}
                {column.nullable ? "?" : ""}
              </span>
              {column.ghostConstraints?.map((c) => (
                <span
                  key={c.label + c.tag.itemId}
                  className="shrink-0 rounded border border-dashed border-ghost/70 px-1 text-[9px] font-sans font-semibold text-ghost"
                >
                  {c.label}
                </span>
              ))}
            </li>
          );
        })}
        {hidden > 0 ? (
          <li className="px-3 pt-0.5 pb-[3px] ps-[2.1rem] text-[11px] text-muted-foreground">
            {t("blueprint.canvas.moreColumns", { count: hidden })}
          </li>
        ) : null}
      </ul>
      <Handle id="fk-in" type="target" position={Position.Right} aria-label={`Rows that belong to ${table.name}`} />
    </div>
  );
});
