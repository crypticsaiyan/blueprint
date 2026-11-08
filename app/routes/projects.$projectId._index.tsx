import { useEffect, useMemo, useState } from "react";

import { BottomPanel, type BottomTab } from "@/components/blueprint/BottomPanel";
import { Inspector } from "@/components/blueprint/Inspector";
import { MapCanvas } from "@/components/blueprint/MapCanvas";
import { useSelection } from "@/lib/blueprint";
import { useWorkspace } from "@/routes/projects.$projectId";

export default function ProjectMapRoute() {
  const workspace = useWorkspace();
  const { projectId, projected, items, map, changeset, result, rehearsal, code, impacts, rules } = workspace;
  const { selection, select } = useSelection();
  const [hydrated, setHydrated] = useState(false);
  const [bottomOpen, setBottomOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>("data");
  useEffect(() => setHydrated(true), []);

  const affectedTables = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      if (item.status === "rejected") continue;
      set.add(item.payload.table);
      const p = item.payload;
      if (p.kind === "add_foreign_key") set.add(p.refTable);
    }
    return set;
  }, [items]);
  const open = rehearsal && !rehearsal.stale ? (result?.conflicts ?? []).filter((c) => !c.resolution) : [];
  const conflictTables = useMemo(() => new Set(open.map((c) => c.table)), [open]);
  const conflictItemIds = useMemo(() => new Set(open.map((c) => c.itemId)), [open]);
  const selectedTable = selection?.type === "table" ? selection.table : null;

  if (!projected) return null;
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          {hydrated ? (
            <MapCanvas
              projectId={projectId}
              projected={projected}
              positions={map.data?.positions ?? {}}
              selection={selection}
              onSelect={select}
              affectedTables={affectedTables}
              conflictTables={conflictTables}
              code={code}
              impacts={impacts}
              rules={rules}
            />
          ) : null}
        </div>
        <BottomPanel
          projectId={projectId}
          table={selectedTable}
          sql={changeset.data?.sql ?? ""}
          result={result}
          stale={Boolean(rehearsal?.stale)}
          impacts={impacts}
          code={code}
          onSelectModule={(path) => select({ type: "module", path })}
          tab={bottomTab}
          onTab={setBottomTab}
          open={bottomOpen}
          onOpenChange={setBottomOpen}
        />
      </div>
      <Inspector
        projectId={projectId}
        goal={map.data?.changeset?.goal ?? ""}
        projected={projected}
        items={items}
        selection={selection}
        onSelect={select}
        conflictItemIds={conflictItemIds}
        code={code}
        impacts={impacts}
        rules={rules}
        onPreview={(table) => {
          select({ type: "table", table });
          setBottomTab("data");
          setBottomOpen(true);
        }}
      />
    </div>
  );
}
