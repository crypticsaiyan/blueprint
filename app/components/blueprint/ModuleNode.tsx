import { IconAlertTriangle, IconFileCode } from "@tabler/icons-react";
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
};
export type ModuleFlowNode = Node<ModuleNodeData, "module">;

export const ModuleNode = memo(function ModuleNode({ data }: NodeProps<ModuleFlowNode>) {
  const { label, queries, severity, selected, violation } = data;
  const slash = label.lastIndexOf("/");
  return (
    <div
      className={cn(
        "flex w-52 items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 shadow-sm",
        severity === "breaks" ? "border-conflict/70 bp-glow-conflict" : severity === "review" ? "border-ghost/70 bp-glow" : "border-border",
        violation && "border-dashed border-fill",
        selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
      )}
    >
      <Handle id="dep-in" type="target" position={Position.Left} isConnectable={false} className="!size-1.5" />
      {severity === "breaks" ? (
        <IconAlertTriangle className="size-4 shrink-0 text-conflict" strokeWidth={1.8} />
      ) : (
        <IconFileCode className={cn("size-4 shrink-0", severity === "review" ? "text-ghost" : "text-muted-foreground")} strokeWidth={1.8} />
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
