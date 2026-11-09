import { actionErrorMessage, useActionMutation } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import {
  IconCheck,
  IconLock,
  IconLockOpen,
  IconPencil,
  IconX,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  changePayloadSchema,
  describeChange,
  type ChangeItem,
  type ChangePayload,
} from "@shared/changes";

type MapData = { changeset: { items: ChangeItem[] } | null } & Record<string, unknown>;

export function ChangeItemRow({
  item,
  projectId,
  selected,
  onSelect,
  conflict,
}: {
  item: ChangeItem;
  projectId: string;
  selected?: boolean;
  onSelect?: () => void;
  conflict?: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const mapKey = ["action", "get-project-map", { projectId }];
  const update = useActionMutation("update-change-item", {
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: mapKey });
      const previous = queryClient.getQueryData(mapKey);
      queryClient.setQueryData(mapKey, (old: MapData | undefined) =>
        old?.changeset
          ? {
              ...old,
              changeset: {
                ...old.changeset,
                items: old.changeset.items.map((i) =>
                  i.id === item.id
                    ? {
                        ...i,
                        ...(input.status ? { status: input.status } : {}),
                        ...(input.locked !== undefined ? { locked: input.locked } : {}),
                        ...(input.change ? { payload: input.change } : {}),
                      }
                    : i,
                ),
              },
            }
          : old,
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      queryClient.setQueryData(mapKey, (context as { previous?: unknown } | undefined)?.previous);
      toast.error(actionErrorMessage(error) ?? t("blueprint.inspector.updateFailed"));
    },
  });

  const rejected = item.status === "rejected";
  return (
    <li
      className={cn(
        "group rounded-lg border bg-card px-3 py-2.5 text-sm shadow-xs transition-colors",
        selected ? "border-ring bg-accent" : "border-border hover:border-foreground/20",
        rejected && "opacity-60",
        conflict && "border-conflict/60 bg-conflict/5",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 text-start focus-visible:outline-none"
        >
          <span className={cn("block font-mono text-[12px] leading-5", rejected && "line-through")}>
            {describeChange(item.payload)}
          </span>
          {item.reason ? (
            <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{item.reason}</span>
          ) : null}
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-1.5 py-px capitalize",
                item.status === "accepted" && "bg-ok/10 text-ok",
                item.status === "proposed" && "bg-muted text-foreground",
                item.status === "rejected" && "bg-muted text-muted-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  item.status === "accepted" && "bg-ok",
                  item.status === "proposed" && "bg-foreground/60",
                  item.status === "rejected" && "bg-muted-foreground",
                )}
              />
              {t(`blueprint.inspector.${item.status}`)}
            </span>
            {item.origin === "drawing" ? (
              <span className="rounded bg-muted px-1.5 py-px text-muted-foreground">
                {t("blueprint.inspector.drawn")}
              </span>
            ) : null}
            {item.locked ? (
              <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-px text-foreground">
                <IconLock className="size-2.5" />
                {t("blueprint.inspector.locked")}
              </span>
            ) : null}
          </span>
        </button>
        <div className="flex shrink-0 items-center opacity-50 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <IconAction
            label={t("blueprint.inspector.accept")}
            active={item.status === "accepted"}
            onClick={() =>
              update.mutate({ id: item.id, status: item.status === "accepted" ? "proposed" : "accepted" })
            }
          >
            <IconCheck className="size-3.5" />
          </IconAction>
          <IconAction
            label={t("blueprint.inspector.reject")}
            active={rejected}
            onClick={() => update.mutate({ id: item.id, status: rejected ? "proposed" : "rejected" })}
          >
            <IconX className="size-3.5" />
          </IconAction>
          <IconAction
            label={item.locked ? t("blueprint.inspector.unlock") : t("blueprint.inspector.lock")}
            active={item.locked}
            onClick={() => update.mutate({ id: item.id, locked: !item.locked })}
          >
            {item.locked ? <IconLock className="size-3.5" /> : <IconLockOpen className="size-3.5" />}
          </IconAction>
          <IconAction label={t("blueprint.inspector.edit")} onClick={() => setEditing(true)}>
            <IconPencil className="size-3.5" />
          </IconAction>
        </div>
      </div>
      {editing ? (
        <EditItemDialog
          item={item}
          onClose={() => setEditing(false)}
          onSave={(change, reason) => {
            update.mutate({ id: item.id, change, reason });
            setEditing(false);
          }}
        />
      ) : null}
    </li>
  );
}

function IconAction({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={label}
          aria-pressed={active}
          className={cn("size-6", active && "bg-secondary text-foreground")}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function EditItemDialog({
  item,
  onClose,
  onSave,
}: {
  item: ChangeItem;
  onClose: () => void;
  onSave: (change: ChangePayload, reason: string) => void;
}) {
  const t = useT();
  const isBackfill = item.payload.kind === "backfill";
  const [text, setText] = useState(
    item.payload.kind === "backfill" ? item.payload.sql : JSON.stringify(item.payload, null, 2),
  );
  const [reason, setReason] = useState(item.reason);
  const [error, setError] = useState<string | null>(null);

  function save() {
    let candidate: unknown;
    if (item.payload.kind === "backfill") {
      candidate = { ...item.payload, sql: text };
    } else {
      try {
        candidate = JSON.parse(text);
      } catch {
        setError(t("blueprint.inspector.invalidJson"));
        return;
      }
    }
    const parsed = changePayloadSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    onSave(parsed.data, reason);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("blueprint.inspector.editTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-change">
              {isBackfill ? t("blueprint.inspector.editSql") : t("blueprint.inspector.editJson")}
            </Label>
            <Textarea
              id="edit-change"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
              }}
              rows={12}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-reason">{t("blueprint.inspector.reason")}</Label>
            <Textarea id="edit-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>
          {error ? <p className="text-sm text-conflict">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("blueprint.inspector.cancel")}
          </Button>
          <Button onClick={save}>{t("blueprint.inspector.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
