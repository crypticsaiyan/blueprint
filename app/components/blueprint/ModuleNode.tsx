import { useT } from "@agent-native/core/client/i18n";
import { IconAlertTriangle, IconFileCode, IconFolder, IconFolderOpen } from "@tabler/icons-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import { cn } from "@/lib/utils";
import type { ImpactSeverity } from "@shared/code-types";

export type ModuleNodeData = {
  path: string;
  label: string;
  queries: number;
  severity: ImpactSeverity | null;
  selected: boolean;
  violation: boolean;
  dimmed: boolean;
};
export type ModuleFlowNode = Node<ModuleNodeData, "module">;

export const ModuleNode = memo(function ModuleNode({ data }: NodeProps<ModuleFlowNode>) {
  const { label, queries, severity, selected, violation, dimmed } = data;
  const slash = label.lastIndexOf("/");
  return (
    <div
      className={cn(
        "flex w-52 items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 shadow-sm transition-opacity",
        severity === "breaks" ? "border-conflict/70 bp-glow-conflict" : severity === "review" ? "border-fill/70" : "border-border",
        violation && "border-dashed border-fill",
        selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        dimmed && "opacity-40",
      )}
    >
      <Handle id="dep-in" type="target" position={Position.Left} isConnectable={false} className="!size-1.5" />
      {severity === "breaks" ? (
        <IconAlertTriangle className="size-4 shrink-0 text-conflict" strokeWidth={1.8} />
      ) : (
        <IconFileCode className={cn("size-4 shrink-0", severity === "review" ? "text-fill" : "text-muted-foreground")} strokeWidth={1.8} />
      )}
      <span className="min-w-0 truncate font-mono text-[11.5px]">
        <span className="text-muted-foreground">{slash >= 0 ? label.slice(0, slash + 1) : ""}</span>
        <span className="font-medium">{slash >= 0 ? label.slice(slash + 1) : label}</span>
      </span>
      <span className="ms-auto shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">{queries}</span>
      <Handle id="code" type="source" position={Position.Bottom} isConnectable={false} className="!size-1.5 !border-0 !bg-transparent" />
      <Handle id="dep-out" type="source" position={Position.Right} isConnectable={false} className="!size-1.5" />
    </div>
  );
});

export type GroupNodeData = {
  folder: string;
  label: string;
  files: number;
  queries: number;
  breaks: number;
  severity: ImpactSeverity | null;
  expanded: boolean;
  dimmed: boolean;
};
// Not "group": React Flow styles its built-in group type with a box of its own.
export type GroupFlowNode = Node<GroupNodeData, "folder">;

/** A folder of modules, drawn as one node until it is opened. */
export const GroupNode = memo(function GroupNode({ data }: NodeProps<GroupFlowNode>) {
  const t = useT();
  const { folder, label, files, queries, breaks, severity, expanded, dimmed } = data;
  const slash = label.lastIndexOf("/");
  return (
    <div
      role="button"
      aria-expanded={expanded}
      aria-label={t(expanded ? "blueprint.canvas.groupCollapse" : "blueprint.canvas.groupExpand", { folder })}
      className={cn(
        "flex w-56 cursor-pointer items-center gap-2 rounded-md border bg-muted/60 px-2.5 py-2 shadow-sm transition-opacity",
        severity === "breaks" ? "border-conflict/70" : severity === "review" ? "border-fill/70" : "border-border",
        expanded && "border-dashed bg-background",
        dimmed && "opacity-40",
      )}
    >
      <Handle id="dep-in" type="target" position={Position.Left} isConnectable={false} className="!size-1.5 !border-0 !bg-transparent" />
      {expanded ? (
        <IconFolderOpen className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
      ) : (
        <IconFolder className={cn("size-4 shrink-0", severity === "breaks" ? "text-conflict" : "text-muted-foreground")} strokeWidth={1.8} />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11.5px]">
          <span className="text-muted-foreground">{slash >= 0 ? label.slice(0, slash + 1) : ""}</span>
          <span className="font-medium">{slash >= 0 ? label.slice(slash + 1) : label}</span>
        </span>
        <span className="block text-[10.5px] text-muted-foreground">
          {t("blueprint.canvas.groupFiles", { count: files })}
          {breaks ? <span className="text-conflict"> · {t("blueprint.canvas.groupBreaks", { count: breaks })}</span> : null}
        </span>
      </span>
      <span className="shrink-0 rounded bg-background px-1 text-[10px] tabular-nums text-muted-foreground">{queries}</span>
      <Handle id="code" type="source" position={Position.Bottom} isConnectable={false} className="!size-1.5 !border-0 !bg-transparent" />
      <Handle id="dep-out" type="source" position={Position.Right} isConnectable={false} className="!size-1.5 !border-0 !bg-transparent" />
    </div>
  );
});
