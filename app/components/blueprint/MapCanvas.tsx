import "@xyflow/react/dist/style.css";

import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import { actionErrorMessage, useActionMutation } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { IconCode, IconPointer, IconSquarePlus } from "@tabler/icons-react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Selection } from "@/lib/blueprint";
import { cn } from "@/lib/utils";
import type { ProjectedSchema } from "@shared/changes";
import type { CodeAnalysis, CodeImpact } from "@shared/code-types";

import { ModuleNode, type ModuleFlowNode } from "./ModuleNode";
import { TableNode, type TableFlowNode } from "./TableNode";

const nodeTypes = { table: TableNode, module: ModuleNode };
type FlowNode = TableFlowNode | ModuleFlowNode;

export interface Rule {
  id: string;
  fromModule: string;
  toModule: string;
}

export function violatesRule(rules: Rule[], from: string, to: string) {
  return rules.some((r) => from.startsWith(r.fromModule) && to.startsWith(r.toModule));
}

interface MapCanvasProps {
  projectId: string;
  projected: ProjectedSchema;
  positions: Record<string, { x: number; y: number }>;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  affectedTables: Set<string>;
  conflictTables: Set<string>;
  code: CodeAnalysis | null;
  impacts: CodeImpact[];
  rules: Rule[];
}

export function MapCanvas(props: MapCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function placeGhosts(
  projected: ProjectedSchema,
  positions: Record<string, { x: number; y: number }>,
) {
  const known = Object.values(positions);
  const top = known.length ? Math.min(...known.map((p) => p.y)) : 0;
  const left = known.length ? Math.min(...known.map((p) => p.x)) : 0;
  const out = new Map<string, { x: number; y: number }>();
  let slot = 0;
  for (const table of projected.tables) {
    const saved = positions[`table:${table.name}`];
    if (saved) out.set(table.name, saved);
    else if (table.position) out.set(table.name, table.position);
    else out.set(table.name, { x: left - 340, y: top + slot++ * 220 });
  }
  return out;
}

function Canvas({
  projectId,
  projected,
  positions,
  selection,
  onSelect,
  affectedTables,
  conflictTables,
  code,
  impacts,
  rules,
}: MapCanvasProps) {
  const t = useT();
  const [showCode, setShowCode] = useState(true);
  const flow = useReactFlow();
  const [mode, setMode] = useState<"select" | "table">("select");
  const [draft, setDraft] = useState<{
    start: { x: number; y: number };
    end: { x: number; y: number };
    done: boolean;
  } | null>(null);
  const [draftName, setDraftName] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);

  // Drag results apply immediately; the saved positions catch up on refetch.
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({});
  const layout = useMemo(
    () => placeGhosts(projected, { ...positions, ...dragged }),
    [projected, positions, dragged],
  );
  const severityByModule = useMemo(() => {
    const out = new Map<string, CodeImpact["severity"]>();
    for (const impact of impacts) {
      if (out.get(impact.module) !== "breaks") out.set(impact.module, impact.severity);
    }
    return out;
  }, [impacts]);
  const selectedModule = selection?.type === "module" ? selection.path : null;
  const selectedTable = selection?.type === "table" ? selection.table : null;

  const computed: FlowNode[] = useMemo(() => {
    const tables: FlowNode[] = projected.tables.map((table) => ({
      id: table.name,
      type: "table" as const,
      position: layout.get(table.name) ?? { x: 0, y: 0 },
      data: {
        table,
        selected: selectedTable === table.name,
        affected: affectedTables.has(table.name),
        conflict: conflictTables.has(table.name),
      },
    }));
    if (!showCode || !code) return tables;
    const known = [...layout.values()];
    const top = known.length ? Math.min(...known.map((p) => p.y)) : 0;
    const left = known.length ? Math.min(...known.map((p) => p.x)) : 0;
    const modules: FlowNode[] = code.modules.map((module, index) => ({
      id: `module:${module.path}`,
      type: "module" as const,
      position:
        dragged[`module:${module.path}`] ??
        positions[`module:${module.path}`] ?? { x: left + (index % 6) * 230, y: top - 260 - Math.floor(index / 6) * 110 },
      data: {
        path: module.path,
        label: module.label,
        queries: code.usages.filter((u) => u.module === module.path).length,
        severity: severityByModule.get(module.path) ?? null,
        selected: selectedModule === module.path,
        violation: module.imports.some((i) => violatesRule(rules, module.path, i.path)),
      },
    }));
    return [...modules, ...tables];
  }, [projected, layout, selectedTable, selectedModule, affectedTables, conflictTables, showCode, code, positions, dragged, severityByModule, rules]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(computed);
  useEffect(() => setNodes(computed), [computed, setNodes]);

  useEffect(() => {
    if (!fitted.current && nodes.length) {
      fitted.current = true;
      requestAnimationFrame(() => flow.fitView({ padding: 0.12, duration: 0 }));
    }
  }, [nodes.length, flow]);

  const edges: Edge[] = useMemo(() => {
    const fkEdges: Edge[] = projected.edges.map((edge) => {
      const ghost = Boolean(edge.ghost);
      const dropped = Boolean(edge.dropped);
      const selected = selection?.type === "edge" && selection.id === edge.id;
      const color = dropped
        ? "hsl(var(--bp-conflict))"
        : ghost
          ? "hsl(var(--bp-ghost))"
          : "hsl(var(--muted-foreground) / 0.55)";
      return {
        id: edge.id,
        source: edge.table,
        sourceHandle: "fk-out",
        target: edge.refTable,
        targetHandle: "fk-in",
        type: "smoothstep",
        label: edge.column,
        animated: ghost && !dropped,
        selectable: true,
        style: {
          stroke: color,
          strokeWidth: selected ? 2.5 : ghost || dropped ? 1.8 : 1.3,
          strokeDasharray: ghost || dropped ? "6 4" : undefined,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      };
    });
    if (!showCode || !code) return fkEdges;
    const tableNames = new Set(projected.tables.map((t) => t.name));
    const usage = new Map<string, { module: string; table: string; write: boolean; severity: CodeImpact["severity"] | null }>();
    for (const u of code.usages) {
      if (!tableNames.has(u.table)) continue;
      const key = `${u.module}|${u.table}`;
      const entry = usage.get(key) ?? { module: u.module, table: u.table, write: false, severity: null };
      entry.write ||= u.kind === "write";
      usage.set(key, entry);
    }
    for (const impact of impacts) {
      const entry = usage.get(`${impact.module}|${impact.table}`);
      if (entry && entry.severity !== "breaks") entry.severity = impact.severity;
    }
    const focus = selectedModule ?? selectedTable;
    const usageEdges: Edge[] = [...usage.values()].map((u) => {
      const focused = focus ? u.module === focus || u.table === focus : false;
      const color =
        u.severity === "breaks"
          ? "hsl(var(--bp-conflict))"
          : u.severity === "review"
            ? "hsl(var(--bp-ghost))"
            : "hsl(var(--muted-foreground))";
      const quiet = !u.severity && !focused;
      return {
        id: `use:${u.module}|${u.table}`,
        source: `module:${u.module}`,
        sourceHandle: "code",
        target: u.table,
        targetHandle: "code",
        type: "default",
        selectable: false,
        animated: u.severity === "breaks",
        style: {
          stroke: color,
          strokeOpacity: quiet ? (focus ? 0.08 : 0.22) : 0.9,
          strokeWidth: u.severity === "breaks" || focused ? 1.8 : 1.1,
          strokeDasharray: u.write ? undefined : "3 4",
        },
      };
    });
    const depEdges: Edge[] = code.modules.flatMap((module) =>
      module.imports.map((dep) => {
        const id = `dep:${module.path}->${dep.path}`;
        const violation = violatesRule(rules, module.path, dep.path);
        const selected = selection?.type === "dep" && selection.from === module.path && selection.to === dep.path;
        const color = violation ? "hsl(var(--bp-fill))" : "hsl(var(--foreground) / 0.5)";
        return {
          id,
          source: `module:${module.path}`,
          sourceHandle: "dep-out",
          target: `module:${dep.path}`,
          targetHandle: "dep-in",
          type: "smoothstep",
          label: violation ? "forbidden" : "imports",
          selectable: true,
          style: { stroke: color, strokeWidth: selected ? 2.5 : 1.5, strokeDasharray: violation ? "6 4" : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        };
      }),
    );
    return [...usageEdges, ...fkEdges, ...depEdges];
  }, [projected.edges, projected.tables, selection, showCode, code, impacts, selectedModule, selectedTable, rules]);

  const move = useActionMutation("move-map-node");
  const drawTable = useActionMutation("draw-table", {
    onSuccess: (result, input) => {
      onSelect({ type: "table", table: input.name });
      toast.success(result.message);
      sendToAgentChat({
        message: t("blueprint.canvas.fillColumnsPrompt", { table: input.name }),
        submit: true,
        openSidebar: true,
      });
    },
    onError: (error) =>
      toast.error(actionErrorMessage(error) ?? t("blueprint.canvas.drawTableFailed")),
  });
  const drawRelationship = useActionMutation("draw-relationship", {
    onSuccess: (result) => toast.success(result.message, { duration: 7000 }),
    onError: (error) =>
      toast.error(actionErrorMessage(error) ?? t("blueprint.canvas.drawRelationFailed")),
  });

  function onConnect(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    if (connection.source.startsWith("module:") || connection.target.startsWith("module:")) return;
    drawRelationship.mutate({
      projectId,
      fromTable: connection.source,
      toTable: connection.target,
    });
  }

  function overlayPoint(event: React.PointerEvent) {
    const rect = overlayRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function submitDraft() {
    if (!draft || !overlayRef.current) return;
    const name = draftName.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    if (!name) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const origin = flow.screenToFlowPosition({
      x: rect.left + Math.min(draft.start.x, draft.end.x),
      y: rect.top + Math.min(draft.start.y, draft.end.y),
    });
    drawTable.mutate({ projectId, name, x: origin.x, y: origin.y });
    setDraft(null);
    setDraftName("");
    setMode("select");
  }

  const box = draft && {
    left: Math.min(draft.start.x, draft.end.x),
    top: Math.min(draft.start.y, draft.end.y),
    width: Math.abs(draft.end.x - draft.start.x),
    height: Math.abs(draft.end.y - draft.start.y),
  };

  return (
    <div className="bp-canvas relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) =>
          onSelect(
            node.type === "module"
              ? { type: "module", path: node.id.slice("module:".length) }
              : { type: "table", table: node.id },
          )
        }
        onEdgeClick={(_, edge) => {
          if (edge.id.startsWith("dep:")) {
            const [from, to] = edge.id.slice(4).split("->");
            onSelect({ type: "dep", from: from!, to: to! });
          } else onSelect({ type: "edge", id: edge.id });
        }}
        onPaneClick={() => onSelect(null)}
        onNodeDragStop={(_, node) => {
          const x = Math.round(node.position.x);
          const y = Math.round(node.position.y);
          const key = node.type === "module" ? node.id : `table:${node.id}`;
          setDragged((prev) => ({ ...prev, [key]: { x, y } }));
          move.mutate({ projectId, key, x, y });
        }}
        deleteKeyCode={null}
        minZoom={0.2}
        maxZoom={1.75}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="hsl(var(--bp-grid))" />
        <Controls showInteractive={false} position="bottom-left" />
        <Panel position="top-left">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-background/95 p-1 shadow-sm backdrop-blur">
            <ToolButton
              active={mode === "select"}
              label={t("blueprint.canvas.toolSelect")}
              hint={t("blueprint.canvas.relationHint")}
              onClick={() => setMode("select")}
            >
              <IconPointer className="size-4" strokeWidth={1.8} />
            </ToolButton>
            <ToolButton
              active={mode === "table"}
              label={t("blueprint.canvas.toolTable")}
              hint={t("blueprint.canvas.toolTableHint")}
              onClick={() => setMode(mode === "table" ? "select" : "table")}
            >
              <IconSquarePlus className="size-4" strokeWidth={1.8} />
            </ToolButton>
            {code ? (
              <ToolButton
                active={showCode}
                label={t("blueprint.canvas.toolCode")}
                hint={t("blueprint.canvas.toolCodeHint")}
                onClick={() => setShowCode(!showCode)}
              >
                <IconCode className="size-4" strokeWidth={1.8} />
              </ToolButton>
            ) : null}
            <span className="hidden px-2 text-xs text-muted-foreground lg:inline">
              {mode === "table" ? t("blueprint.canvas.toolTableHint") : t("blueprint.canvas.relationHint")}
            </span>
          </div>
        </Panel>
      </ReactFlow>

      {mode === "table" || draft ? (
        <div
          ref={overlayRef}
          className={cn("absolute inset-0 z-10", mode === "table" && !draft?.done && "cursor-crosshair")}
          onPointerDown={(event) => {
            if (draft?.done) return;
            const point = overlayPoint(event);
            (event.target as HTMLElement).setPointerCapture(event.pointerId);
            setDraft({ start: point, end: point, done: false });
          }}
          onPointerMove={(event) => {
            if (!draft || draft.done) return;
            setDraft({ ...draft, end: overlayPoint(event) });
          }}
          onPointerUp={(event) => {
            if (!draft || draft.done) return;
            const end = overlayPoint(event);
            const tiny = Math.abs(end.x - draft.start.x) < 12 || Math.abs(end.y - draft.start.y) < 12;
            setDraft({
              start: draft.start,
              end: tiny ? { x: draft.start.x + 240, y: draft.start.y + 120 } : end,
              done: true,
            });
          }}
        >
          {box ? (
            <div
              className="absolute rounded-lg border-2 border-dashed border-ghost bg-ghost/5"
              style={box}
            >
              {draft?.done ? (
                <form
                  className="p-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitDraft();
                  }}
                >
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setDraft(null);
                        setDraftName("");
                        setMode("select");
                      }
                    }}
                    onBlur={() => {
                      if (!draftName.trim()) {
                        setDraft(null);
                        setMode("select");
                      }
                    }}
                    placeholder={t("blueprint.canvas.tableNamePlaceholder")}
                    aria-label={t("blueprint.canvas.tableNamePlaceholder")}
                    className="w-full rounded border border-ghost/60 bg-background px-2 py-1 font-mono text-sm outline-none focus:ring-2 focus:ring-ghost/40"
                  />
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolButton({
  active,
  label,
  hint,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant={active ? "secondary" : "ghost"}
          className="size-8"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="font-medium">{label}</p>
        <p className="text-xs opacity-80">{hint}</p>
      </TooltipContent>
    </Tooltip>
  );
}
