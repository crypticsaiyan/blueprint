import { useT } from "@agent-native/core/client/i18n";
import { IconFlask } from "@tabler/icons-react";

import { RehearsalView } from "@/components/blueprint/RehearsalView";
import { useWorkspace } from "@/routes/projects.$projectId";

export default function ProjectRehearseRoute() {
  const t = useT();
  const { projectId, result, rehearsal } = useWorkspace();
  return (
    <RehearsalView
      projectId={projectId}
      rehearsalId={rehearsal?.id ?? null}
      result={result}
      stale={Boolean(rehearsal?.stale)}
      empty={
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-20 text-center">
          <IconFlask className="size-8 text-ghost" strokeWidth={1.5} />
          <p className="text-sm font-medium">{t("blueprint.rehearsal.empty")}</p>
          <p className="text-sm text-muted-foreground">{t("blueprint.rehearsal.runFirst")}</p>
        </div>
      }
    />
  );
}
