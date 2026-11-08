import { useActionQuery } from "@agent-native/core/client/hooks";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";

import {
  projectSchema,
  type ChangeItem,
  type ProjectedSchema,
} from "@shared/changes";
import type { RehearsalResult } from "@shared/rehearsal-types";
import type { SchemaSnapshot } from "@shared/schema-types";

export type Selection =
  | { type: "table"; table: string }
  | { type: "edge"; id: string }
  | { type: "item"; id: string }
  | { type: "conflict"; key: string }
  | null;

export function parseSelection(raw: string | null): Selection {
  if (!raw) return null;
  const index = raw.indexOf(":");
  if (index < 0) return null;
  const kind = raw.slice(0, index);
  const ref = raw.slice(index + 1);
  if (!ref) return null;
  if (kind === "table") return { type: "table", table: ref };
  if (kind === "edge") return { type: "edge", id: ref };
  if (kind === "item") return { type: "item", id: ref };
  if (kind === "conflict") return { type: "conflict", key: ref };
  return null;
}

export function selectionParam(selection: Selection): string | null {
  if (!selection) return null;
  switch (selection.type) {
    case "table":
      return `table:${selection.table}`;
    case "edge":
      return `edge:${selection.id}`;
    case "item":
      return `item:${selection.id}`;
    case "conflict":
      return `conflict:${selection.key}`;
  }
}

/** Selection lives in the URL (?sel=) so the agent sees it in navigation. */
export function useSelection() {
  const [params, setParams] = useSearchParams();
  const selection = parseSelection(params.get("sel"));
  const select = useCallback(
    (next: Selection) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          const value = selectionParam(next);
          if (value) out.set("sel", value);
          else out.delete("sel");
          return out;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return { selection, select };
}

export function useProjectData(projectId: string) {
  const map = useActionQuery("get-project-map", { projectId });
  const changeset = useActionQuery("get-changeset", { projectId });
  const snapshot = map.data?.schema as unknown as SchemaSnapshot | undefined;
  const items = (map.data?.changeset?.items ?? []) as unknown as ChangeItem[];
  const projected: ProjectedSchema | null = useMemo(
    () => (snapshot ? projectSchema(snapshot, items) : null),
    [snapshot, items],
  );
  const rehearsal = changeset.data?.rehearsal ?? null;
  const result = (rehearsal?.result ?? null) as unknown as RehearsalResult | null;
  return { map, changeset, snapshot, items, projected, rehearsal, result };
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  // Timestamps from JSON arrive as ISO strings; shorten them for tables.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(text)) {
    return text.slice(0, 16).replace("T", " ");
  }
  return text;
}

export function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "errorCode" in error) {
    const code = (error as { errorCode?: unknown }).errorCode;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
