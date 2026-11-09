import "@xyflow/react/dist/style.css";

import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import { actionErrorMessage, useActionMutation } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { IconCode, IconLayoutDistributeHorizontal, IconPointer, IconSquarePlus } from "@tabler/icons-react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Selection } from "@/lib/blueprint";
import { groupModules } from "@/lib/module-groups";
import { cn } from "@/lib/utils";
import type { ProjectedSchema } from "@shared/changes";
import type { CodeAnalysis, CodeImpact } from "@shared/code-types";
import { COMPACT_TABLES } from "@shared/map-layout";

import { GroupNode, ModuleNode, type GroupFlowNode, type ModuleFlowNode } from "./ModuleNode";
import { TableNode, type TableFlowNode } from "./TableNode";

const nodeTypes = { table: TableNode, module: ModuleNode, folder: GroupNode };
type FlowNode = TableFlowNode | ModuleFlowNode | GroupFlowNode;

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

/**
 * Where proposed tables go: drawn ones keep their spot; others join the
 * column right of the table they reference (children sit right of parents),
 * below what is already there.
 */
function placeGhosts(
  projected: ProjectedSchema,
  positions: Record<string, { x: number; y: number }>,
  compact: boolean,
) {
  const out = new Map<string, { x: number; y: number }>();
  const height = (name: string) => {
    const table = projected.tables.find((t) => t.name === name);
    return 44 + 19 * (compact ? 2 : (table?.columns.length ?? 4));
  };
  for (const table of projected.tables) {
    const saved = positions[`table:${table.name}`];
    if (saved) out.set(table.name, saved);
    else if (table.position) out.set(table.name, table.position);
  }
  const placed = [...out.values()];
  const top = placed.length ? Math.min(...placed.map((p) => p.y)) : 0;
  const left = placed.length ? Math.min(...placed.map((p) => p.x)) : 0;
  let slot = 0;
  for (const table of projected.tables) {
    if (out.has(table.name)) continue;
    const parent = table.columns.map((c) => projected.edges.find((e) => e.table === table.name && e.column === c.name)?.refTable).find((t) => t && out.has(t));
    if (parent) {
      const x = out.get(parent)!.x + 300;
      const column = [...out].filter(([, p]) => Math.abs(p.x - x) < 150);
      const y = column.length ? Math.max(...column.map(([name, p]) => p.y + height(name))) + 40 : out.get(parent)!.y;
      out.set(table.name, { x, y });
    } else {
      out.set(table.name, { x: left - 340, y: top + slot++ * 220 });
    }
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

  // Drag results apply immediately; the saved positions catch up on refetch.
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({});
  const compactCards = projected.tables.length > COMPACT_TABLES;
  const layout = useMemo(
    () => placeGhosts(projected, { ...positions, ...dragged }, compactCards),
    [projected, positions, dragged, compactCards],
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

  // Large repos: folders instead of hundreds of module nodes, compact tables,
  // and usage edges only where the change matters or the user is looking.
  const groups = useMemo(() => (code ? groupModules(code.modules.map((m) => m.path)) : null), [code]);
  const groupOf = useMemo(() => {
    const out = new Map<string, string>();
    for (const g of groups ?? []) for (const m of g.modules) out.set(m, g.key);
    return out;
  }, [groups]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    const folder = selectedModule ? groupOf.get(selectedModule) : undefined;
    if (folder) setExpanded((prev) => (prev.has(folder) ? prev : new Set(prev).add(folder)));
  }, [selectedModule, groupOf]);
  const compact = compactCards;
  const large = compact || groups !== null;
  const [hovered, setHovered] = useState<string | null>(null);
  /** The node a module's edges attach to: itself, or its folder while folded. */
  const nodeFor = useCallback(
    (path: string) => {
      const folder = groupOf.get(path);
      return folder && !expanded.has(folder) ? `group:${folder}` : `module:${path}`;
    },
    [groupOf, expanded],
  );

  const usage = useMemo(() => {
    const out = new Map<string, { node: string; table: string; write: boolean; severity: CodeImpact["severity"] | null }>();
    if (!showCode || !code) return out;
    const tableNames = new Set(projected.tables.map((t) => t.name));
    for (const u of code.usages) {
      if (!tableNames.has(u.table)) continue;
      const node = nodeFor(u.module);
      const key = `${node}|${u.table}`;
      const entry = out.get(key) ?? { node, table: u.table, write: false, severity: null };
      entry.write ||= u.kind === "write";
      out.set(key, entry);
    }
    for (const impact of impacts) {
      const entry = out.get(`${nodeFor(impact.module)}|${impact.table}`);
      if (entry && entry.severity !== "breaks") entry.severity = impact.severity;
    }
    return out;
  }, [showCode, code, projected.tables, impacts, nodeFor]);

  // What the user is looking at: a hovered node wins over the selection.
  const focus = hovered ?? (selectedModule ? nodeFor(selectedModule) : selectedTable);
  const related = useMemo(() => {
    if (!focus) return null;
    const out = new Set([focus]);
    for (const u of usage.values()) {
      if (u.node === focus) out.add(u.table);
      if (u.table === focus) out.add(u.node);
    }
    for (const e of projected.edges) {
      if (e.table === focus) out.add(e.refTable);
      if (e.refTable === focus) out.add(e.table);
    }
    return out;
  }, [focus, usage, projected.edges]);
  const dim = (id: string) => large && related !== null && !related.has(id);

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
        compact,
        dimmed: dim(table.name),
      },
    }));
    if (!showCode || !code) return tables;
    const known = [...layout.values()];
    const top = known.length ? Math.min(...known.map((p) => p.y)) : 0;
    const left = known.length ? Math.min(...known.map((p) => p.x)) : 0;
    const right = known.length ? Math.max(...known.map((p) => p.x)) + 240 : 1200;
    const moduleNode = (path: string, position: { x: number; y: number }): FlowNode => {
      const module = code.modules.find((m) => m.path === path)!;
      return {
        id: `module:${path}`,
        type: "module" as const,
        position: dragged[`module:${path}`] ?? position,
        data: {
          path,
          label: groups ? path.slice((groupOf.get(path)?.length ?? -1) + 1) : module.label,
          queries: code.usages.filter((u) => u.module === path).length,
          severity: severityByModule.get(path) ?? null,
          selected: selectedModule === path,
          violation: module.imports.some((i) => violatesRule(rules, path, i.path)),
          dimmed: dim(`module:${path}`),
        },
      };
    };
    if (!groups) {
      return [
        ...code.modules.map((module, index) =>
          moduleNode(
            module.path,
            positions[`module:${module.path}`] ?? { x: left + (index % 6) * 230, y: top - 260 - Math.floor(index / 6) * 110 },
          ),
        ),
        ...tables,
      ];
    }
    // Folders sit in a row above the tables; an open folder stacks its files above itself.
    const step = 250;
    const perRow = Math.max(1, Math.floor((right - left) / step));
    const rows = Math.ceil(groups.length / perRow);
    const nodes: FlowNode[] = [];
    groups.forEach((group, index) => {
      const id = `group:${group.key}`;
      const position = dragged[id] ?? { x: left + (index % perRow) * step, y: top - 140 - (rows - 1 - Math.floor(index / perRow)) * 80 };
      const open = expanded.has(group.key);
      const severities = group.modules.map((m) => severityByModule.get(m));
      nodes.push({
        id,
        type: "folder" as const,
        position,
        data: {
          folder: group.key,
          label: group.key,
          files: group.modules.length,
          queries: code.usages.filter((u) => groupOf.get(u.module) === group.key).length,
          breaks: severities.filter((v) => v === "breaks").length,
          severity: severities.includes("breaks") ? "breaks" : severities.includes("review") ? "review" : null,
          expanded: open,
          dimmed: dim(id),
        },
      });
      if (open) {
        group.modules.forEach((path, i) => nodes.push(moduleNode(path, { x: position.x + 8, y: position.y - 56 * (i + 1) - 16 - (rows - 1) * 80 })));
      }
    });
    return [...nodes, ...tables];
  }, [projected, layout, selectedTable, selectedModule, affectedTables, conflictTables, showCode, code, positions, dragged, severityByModule, rules, groups, groupOf, expanded, compact, related]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(computed);
  // Keep each node's measured size across updates. React Flow treats a node
  // without `measured` as brand new: it hides it, re-measures it and redraws
  // its edges, so every selection or refetch made the whole canvas blink.
  useEffect(
    () =>
      setNodes((current) => {
        const byId = new Map(current.map((node) => [node.id, node]));
        return computed.map((next) => {
          const prev = byId.get(next.id);
          if (!prev) return next;
          const kept = { ...next } as FlowNode;
          if (prev.measured) kept.measured = prev.measured;
          if (prev.selected !== undefined) kept.selected = prev.selected;
          return kept;
        });
      }),
    [computed, setNodes],
  );

  // A large map opens on what the changeset touches, readable, rather than
  // the whole schema shrunk to fit. The changeset can arrive after the first
  // paint, so the view refits once more then, unless the user has moved it.
  const initialized = useNodesInitialized();
  const userMoved = useRef(false);
  const focusKey = large ? [...affectedTables].sort().join(",") : "";
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized || userMoved.current || fittedFor.current === focusKey) return;
    if (fittedFor.current !== null && !focusKey) return;
    fittedFor.current = focusKey;
    const touched = focusKey ? focusKey.split(",") : [];
    requestAnimationFrame(() =>
      touched.length
        ? flow.fitView({ nodes: touched.map((id) => ({ id })), padding: 0.6, maxZoom: 0.9, duration: 0 })
        : // Big schemas open readable at the center instead of shrunk to fit.
          flow.fitView({ padding: 0.12, duration: 0, ...(large ? { minZoom: 0.55 } : {}) }),
    );
  }, [initialized, focusKey, flow, large]);

  const edges: Edge[] = useMemo(() => {
    const fkEdges: Edge[] = projected.edges.map((edge) => {
      const ghost = Boolean(edge.ghost);
      const dropped = Boolean(edge.dropped);
      const selected = selection?.type === "edge" && selection.id === edge.id;
      const touched = focus === edge.table || focus === edge.refTable;
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
        // Labels on every edge of a big schema are noise; show them where the eye is.
        label: !large || selected || touched || ghost || dropped ? edge.column : undefined,
        animated: ghost && !dropped,
        selectable: true,
        style: {
          stroke: color,
          strokeWidth: selected ? 2.5 : ghost || dropped ? 2.2 : touched ? 1.8 : 1.3,
          strokeDasharray: ghost || dropped ? "6 4" : undefined,
          opacity: large && focus && !touched && !ghost && !dropped ? 0.15 : 1,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      };
    });
    if (!showCode || !code) return fkEdges;
    const usageEdges: Edge[] = [];
    for (const u of usage.values()) {
      const focused = focus ? u.node === focus || u.table === focus : false;
      // Large maps draw a usage only when the change touches it or it is in focus.
      if (large && !u.severity && !focused) continue;
      const color =
        u.severity === "breaks"
          ? "hsl(var(--bp-conflict))"
          : u.severity === "review"
            ? "hsl(var(--bp-fill))"
            : "hsl(var(--muted-foreground))";
      const quiet = !u.severity && !focused;
      usageEdges.push({
        id: `use:${u.node}|${u.table}`,
        source: u.node,
        sourceHandle: "code",
        target: u.table,
        targetHandle: "code",
        type: "default",
        selectable: false,
        animated: u.severity === "breaks" && (!large || focused || !focus),
        style: {
          stroke: color,
          strokeOpacity: quiet ? (focus ? 0.08 : 0.22) : large && focus && !focused ? 0.2 : 0.9,
          strokeWidth: u.severity === "breaks" || focused ? 1.8 : 1.1,
          strokeDasharray: u.write ? undefined : "3 4",
        },
      });
    }
    const deps = new Map<string, { from: string; to: string; source: string; target: string; violation: boolean }>();
    for (const module of code.modules) {
      for (const dep of module.imports) {
        const source = nodeFor(module.path);
        const target = nodeFor(dep.path);
        if (source === target) continue;
        const violation = violatesRule(rules, module.path, dep.path);
        if (large && !violation && focus !== source && focus !== target) continue;
        const key = `${source}->${target}`;
        const entry = deps.get(key);
        if (entry) entry.violation ||= violation;
        else deps.set(key, { from: module.path, to: dep.path, source, target, violation });
      }
    }
    const depEdges: Edge[] = [...deps.values()].map(({ from, to, source, target, violation }) => {
      const selected = selection?.type === "dep" && selection.from === from && selection.to === to;
      const color = violation ? "hsl(var(--bp-fill))" : "hsl(var(--foreground) / 0.5)";
      return {
        id: `dep:${from}->${to}`,
        source,
        sourceHandle: "dep-out",
        target,
        targetHandle: "dep-in",
        type: "smoothstep",
        label: violation ? "forbidden" : large ? undefined : "imports",
        selectable: true,
        style: { stroke: color, strokeWidth: selected ? 2.5 : 1.5, strokeDasharray: violation ? "6 4" : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      };
    });
    return [...usageEdges, ...fkEdges, ...depEdges];
  }, [projected.edges, selection, showCode, code, usage, focus, large, rules, nodeFor]);

  const arrange = useActionMutation("arrange-map", {
    onSuccess: () => {
      setDragged({});
      setTimeout(() => flow.fitView({ padding: 0.12, duration: 300 }), 350);
    },
    onError: (error) => toast.error(actionErrorMessage(error) ?? t("blueprint.canvas.arrangeFailed")),
  });
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
        connectionLineType={ConnectionLineType.Bezier}
        connectionLineStyle={{ stroke: "hsl(var(--bp-ghost))", strokeWidth: 2.5, strokeDasharray: "6 4" }}
        onNodeClick={(_, node) => {
          if (node.type === "folder") {
            const folder = node.id.slice("group:".length);
            setExpanded((prev) => {
              const next = new Set(prev);
              if (!next.delete(folder)) next.add(folder);
              return next;
            });
            return;
          }
          onSelect(
            node.type === "module"
              ? { type: "module", path: node.id.slice("module:".length) }
              : { type: "table", table: node.id },
          );
        }}
        onNodeMouseEnter={(_, node) => large && setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
        onEdgeClick={(_, edge) => {
          if (edge.id.startsWith("dep:")) {
            const [from, to] = edge.id.slice(4).split("->");
            onSelect({ type: "dep", from: from!, to: to! });
          } else onSelect({ type: "edge", id: edge.id });
        }}
        onPaneClick={() => onSelect(null)}
        onMoveStart={(event) => {
          // Only a pan or zoom by hand counts, not the fits above.
          const source = (event as { sourceEvent?: Event } | null)?.sourceEvent ?? event;
          if (source instanceof MouseEvent || source instanceof WheelEvent || (typeof TouchEvent !== "undefined" && source instanceof TouchEvent)) {
            userMoved.current = true;
          }
        }}
        onNodeDragStop={(_, node) => {
          const x = Math.round(node.position.x);
          const y = Math.round(node.position.y);
          const key = node.type === "table" ? `table:${node.id}` : node.id;
          setDragged((prev) => ({ ...prev, [key]: { x, y } }));
          // Folder groups are laid out on the fly; only real nodes are saved.
          if (node.type !== "folder") move.mutate({ projectId, key, x, y });
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
            <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
            <ToolButton
              active={false}
              label={t("blueprint.canvas.toolArrange")}
              hint={t("blueprint.canvas.toolArrangeHint")}
              onClick={() => arrange.mutate({ projectId })}
            >
              <IconLayoutDistributeHorizontal className="size-4" strokeWidth={1.8} />
            </ToolButton>
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
