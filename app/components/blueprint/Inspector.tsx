import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import {
  actionErrorMessage,
  callAction,
  useActionMutation,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import {
  IconArrowRight,
  IconDatabase,
  IconKey,
  IconRefresh,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { Selection } from "@/lib/blueprint";
import { formatCell } from "@/lib/blueprint";
import { cn } from "@/lib/utils";
import type { ChangeItem, ProjectedEdge, ProjectedSchema } from "@shared/changes";
import type { CodeAnalysis, CodeImpact } from "@shared/code-types";

import { ChangeItemRow } from "./ChangeItemRow";
import { DepDetail, ModuleDetail, TableQueries } from "./CodePanels";
import type { Rule } from "./MapCanvas";
import { shortType } from "./TableNode";

interface InspectorProps {
  projectId: string;
  goal: string;
  projected: ProjectedSchema;
  items: ChangeItem[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onPreview: (table: string) => void;
  conflictItemIds: Set<string>;
  code: CodeAnalysis | null;
  impacts: CodeImpact[];
  rules: Rule[];
}

function touches(item: ChangeItem, table: string) {
  const p = item.payload;
  if (p.table === table) return true;
  if (p.kind === "add_foreign_key" || p.kind === "drop_foreign_key") return p.refTable === table;
  if (p.kind === "add_column") return p.column.references?.table === table;
  return false;
}

export function Inspector({
  projectId,
  goal,
  projected,
  items,
  selection,
  onSelect,
  onPreview,
  conflictItemIds,
  code,
  impacts,
  rules,
}: InspectorProps) {
  const t = useT();
  const ask = (message: string) => sendToAgentChat({ message, submit: true, openSidebar: true });
  const ordered = [...items].sort((a, b) => a.position - b.position);

  let detail: React.ReactNode = null;
  if (selection?.type === "table") {
    const table = projected.tables.find((x) => x.name === selection.table);
    const related = ordered.filter((item) => touches(item, selection.table));
    detail = table ? (
      <section className="space-y-3 border-b border-border p-4">
        <div className="flex items-center gap-2">
          <h2 className={cn("truncate font-mono text-sm font-semibold", table.ghost && "text-ghost")}>
            {table.name}
          </h2>
          {table.rowCount !== null ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("blueprint.canvas.rows", { count: table.rowCount })}
            </span>
          ) : null}
          {table.rowCount !== null ? (
            <Button
              variant="outline"
              size="sm"
              className="ms-auto h-7 gap-1.5 text-xs"
              onClick={() => onPreview(table.name)}
            >
              <IconDatabase className="size-3.5" />
              {t("blueprint.inspector.previewData")}
            </Button>
          ) : null}
        </div>
        <div>
          <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("blueprint.inspector.columns")}
          </h3>
          <ul className="space-y-0.5 font-mono text-xs">
            {table.columns.map((c) => (
              <li
                key={c.name}
                className={cn("flex items-center gap-1.5", c.ghost && "text-ghost")}
              >
                {c.isPrimaryKey ? <IconKey className="size-3 text-fill" /> : <span className="size-3" />}
                <span>{c.name}</span>
                <span className="ms-auto text-muted-foreground">
                  {shortType(c.type)}
                  {c.nullable ? "" : " not null"}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("blueprint.inspector.changes")}
          </h3>
          {related.length ? (
            <ul className="-mx-2.5 space-y-0.5">
              {related.map((item) => (
                <ChangeItemRow
                  key={item.id}
                  item={item}
                  projectId={projectId}
                  conflict={conflictItemIds.has(item.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t("blueprint.inspector.noChanges")}</p>
          )}
        </div>
        {code ? <TableQueries table={table.name} code={code} impacts={impacts} /> : null}
      </section>
    ) : (
      <p className="border-b border-border p-4 text-sm text-muted-foreground">
        {t("blueprint.inspector.tableMissing")}
      </p>
    );
  } else if (selection?.type === "edge") {
    const edge = projected.edges.find((e) => e.id === selection.id);
    if (edge) detail = <EdgeDetail edge={edge} projectId={projectId} items={ordered} onDone={() => onSelect(null)} />;
  } else if (selection?.type === "module" && code) {
    detail = <ModuleDetail path={selection.path} code={code} impacts={impacts} rules={rules} />;
  } else if (selection?.type === "dep" && code) {
    detail = <DepDetail projectId={projectId} from={selection.from} to={selection.to} code={code} rules={rules} />;
  }

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col overflow-hidden border-s border-border bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail}
        <section className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {selection ? t("blueprint.inspector.allChanges") : t("blueprint.inspector.changeset")}
            </h2>
            {ordered.length ? (
              <Button
                variant="ghost"
                size="sm"
                className="ms-auto h-7 gap-1.5 text-xs"
                onClick={() => ask(t("blueprint.inspector.replanPrompt"))}
              >
                <IconRefresh className="size-3.5" />
                {t("blueprint.inspector.replan")}
              </Button>
            ) : null}
          </div>
          {goal ? <p className="mb-2 text-sm font-medium">{goal}</p> : null}
          {ordered.length ? (
            <ul className="-mx-2.5 space-y-0.5">
              {ordered.map((item) => (
                <ChangeItemRow
                  key={item.id}
                  item={item}
                  projectId={projectId}
                  conflict={conflictItemIds.has(item.id)}
                  onSelect={() => onSelect({ type: "table", table: item.payload.table })}
                />
              ))}
            </ul>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t("blueprint.inspector.emptyHint")}</p>
              <div className="flex flex-col gap-1.5">
                {[
                  [t("blueprint.inspector.suggestOrgs"), t("blueprint.inspector.suggestOrgsPrompt")],
                  [t("blueprint.inspector.suggestEmails"), t("blueprint.inspector.suggestEmailsPrompt")],
                ].map(([label, prompt]) => (
                  <Button
                    key={label}
                    variant="outline"
                    size="sm"
                    className="justify-start gap-2"
                    onClick={() => ask(prompt!)}
                  >
                    <IconSparkles className="size-3.5 text-ghost" />
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

type DeletePreview = {
  ghost: boolean;
  dependentRows: number;
  totalRows: number;
  sample: Record<string, unknown>[];
  message: string;
};

function EdgeDetail({
  edge,
  projectId,
  items,
  onDone,
}: {
  edge: ProjectedEdge;
  projectId: string;
  items: ChangeItem[];
  onDone: () => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const remove = useActionMutation("delete-relationship", {
    onSuccess: (result) => {
      toast.success(result.message);
      setPreview(null);
      onDone();
    },
    onError: (error) => toast.error(actionErrorMessage(error) ?? t("blueprint.inspector.deleteFailed")),
  });
  const args = { projectId, table: edge.table, column: edge.column, refTable: edge.refTable };
  const owner = items.find((i) => i.id === (edge.ghost ?? edge.dropped)?.itemId);

  async function openPreview() {
    setChecking(true);
    try {
      const result = (await callAction("delete-relationship", { ...args, confirm: false })) as DeletePreview;
      setPreview(result);
    } catch (error) {
      toast.error(actionErrorMessage(error) ?? t("blueprint.inspector.deleteFailed"));
    } finally {
      setChecking(false);
    }
  }

  const columns = preview?.sample[0] ? Object.keys(preview.sample[0]).slice(0, 4) : [];
  return (
    <section className="space-y-3 border-b border-border p-4">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {edge.dropped
          ? t("blueprint.inspector.droppedRelationship")
          : edge.ghost
            ? t("blueprint.inspector.proposedRelationship")
            : t("blueprint.inspector.relationship")}
      </h3>
      <p className={cn("flex items-center gap-1.5 font-mono text-sm", edge.ghost && "text-ghost", edge.dropped && "text-conflict line-through")}>
        {edge.table}.{edge.column}
        <IconArrowRight className="size-3.5" />
        {edge.refTable}.{edge.refColumn}
      </p>
      {edge.constraint ? <p className="font-mono text-xs text-muted-foreground">{edge.constraint}</p> : null}
      {owner ? <ul className="-mx-2.5"><ChangeItemRow item={owner} projectId={projectId} /></ul> : null}
      {!edge.dropped ? (
        <Button variant="outline" size="sm" className="gap-1.5" disabled={checking} onClick={openPreview}>
          <IconTrash className="size-3.5" />
          {checking ? t("blueprint.inspector.checkingImpact") : t("blueprint.inspector.deleteRelationship")}
        </Button>
      ) : null}
      <AlertDialog open={Boolean(preview)} onOpenChange={(open) => !open && setPreview(null)}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("blueprint.inspector.deleteTitle", { table: edge.table, column: edge.column, refTable: edge.refTable })}
            </AlertDialogTitle>
            <AlertDialogDescription>{preview?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          {preview && preview.sample.length ? (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full font-mono text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    {columns.map((c) => (
                      <th key={c} className="px-2 py-1 text-start font-medium">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((row, i) => (
                    <tr key={i} className="border-t border-border">
                      {columns.map((c) => (
                        <td key={c} className={cn("px-2 py-1", c === edge.column && "text-conflict")}>
                          {formatCell(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("blueprint.inspector.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={(event) => {
                event.preventDefault();
                remove.mutate({ ...args, confirm: true });
              }}
            >
              {t("blueprint.inspector.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
