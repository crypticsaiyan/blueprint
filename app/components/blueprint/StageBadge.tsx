import { useT } from "@agent-native/core/client/i18n";

import { cn } from "@/lib/utils";
import { STAGE_TONE, type Stage } from "@shared/stage";

const DOT: Record<(typeof STAGE_TONE)[Stage], string> = {
  muted: "bg-muted-foreground/40",
  neutral: "bg-foreground/60",
  conflict: "bg-conflict",
  ok: "bg-ok",
  fill: "bg-fill",
};

/** Tinted pill per tone: a soft surface with the tone's text. */
const PILL: Record<(typeof STAGE_TONE)[Stage], string> = {
  muted: "bg-muted text-muted-foreground",
  neutral: "bg-muted text-foreground",
  conflict: "bg-conflict/10 text-conflict",
  ok: "bg-ok/10 text-ok",
  fill: "bg-fill/10 text-fill",
};

export function StageDot({ stage, className }: { stage: Stage; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[STAGE_TONE[stage]], className)} />;
}

/** "Ready to ship", "Conflicts to fix", ... with its status dot. */
export function StageLabel({
  stage,
  changes,
  prNumber,
  className,
}: {
  stage: Stage;
  changes: number;
  prNumber?: number | undefined;
  className?: string;
}) {
  const t = useT();
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 justify-self-start rounded-full px-2 py-0.5 text-xs font-medium",
        PILL[STAGE_TONE[stage]],
        className,
      )}
    >
      <StageDot stage={stage} />
      <span className="truncate">{t(`blueprint.projects.stage.${stage}`, { count: changes, number: prNumber ?? 0 })}</span>
    </span>
  );
}
