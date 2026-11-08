import { actionErrorMessage, useActionMutation } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { useSetHeaderActions, useSetPageTitle } from "@agent-native/toolkit/app-shell";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconLoader2,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { useMemo } from "react";
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectData } from "@/lib/blueprint";
import { cn } from "@/lib/utils";

export type WorkspaceContext = ReturnType<typeof useProjectData> & { projectId: string };

export function useWorkspace() {
  return useOutletContext<WorkspaceContext>();
}

export function meta() {
  return [{ title: "Blueprint" }];
}

export default function ProjectWorkspaceRoute() {
  const t = useT();
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const data = useProjectData(projectId);
  const project = data.map.data?.project;
  const rehearsal = data.changeset.data?.rehearsal ?? null;
  const openConflicts = (data.result?.conflicts ?? []).filter((c) => !c.resolution).length;
  const hasItems = data.items.some((i) => i.status !== "rejected");

  const rehearse = useActionMutation("rehearse-migration", {
    onSuccess: (result) => {
      toast[result.status === "passed" ? "success" : "warning"](result.message);
      navigate(`/projects/${encodeURIComponent(projectId)}/rehearse`);
    },
    onError: (error) => toast.error(actionErrorMessage(error) ?? t("blueprint.workspace.rehearseFailed")),
  });

  useSetPageTitle(project ? <span className="font-mono">{project.name}</span> : null);
  const status = !rehearsal
    ? { icon: IconCircleDashed, label: t("blueprint.workspace.statusNone"), className: "text-muted-foreground" }
    : rehearsal.stale
      ? { icon: IconCircleDashed, label: t("blueprint.workspace.statusStale"), className: "text-fill" }
      : rehearsal.status === "passed"
        ? { icon: IconCircleCheck, label: t("blueprint.workspace.statusPassed"), className: "text-ok" }
        : rehearsal.status === "conflicts"
          ? { icon: IconAlertTriangle, label: `${t("blueprint.workspace.statusConflicts")} (${openConflicts})`, className: "text-conflict" }
          : { icon: IconAlertTriangle, label: t("blueprint.workspace.statusFailed"), className: "text-conflict" };
  const StatusIcon = status.icon;

  const actions = useMemo(
    () => (
      <div className="flex items-center gap-2">
        <nav className="hidden items-center rounded-lg bg-muted p-0.5 sm:flex">
          {[
            { to: `/projects/${encodeURIComponent(projectId)}`, label: t("blueprint.workspace.tabMap"), end: true },
            { to: `/projects/${encodeURIComponent(projectId)}/rehearse`, label: t("blueprint.workspace.tabRehearse"), end: false },
            { to: `/projects/${encodeURIComponent(projectId)}/ship`, label: t("blueprint.workspace.tabShip"), end: false },
          ].map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors",
                  isActive && "bg-background text-foreground shadow-sm",
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
        <span className={cn("hidden items-center gap-1 text-xs md:flex", status.className)}>
          <StatusIcon className="size-3.5" />
          {status.label}
        </span>
        <Button
          size="sm"
          className="h-8 gap-1.5"
          disabled={!hasItems || rehearse.isPending}
          onClick={() => rehearse.mutate({ projectId })}
        >
          {rehearse.isPending ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconPlayerPlay className="size-3.5" />}
          {rehearse.isPending ? t("blueprint.workspace.rehearsing") : t("blueprint.workspace.rehearse")}
        </Button>
      </div>
    ),
    [projectId, t, status.className, status.label, StatusIcon, hasItems, rehearse],
  );
  useSetHeaderActions(actions);

  if (data.map.isError) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">{t("blueprint.workspace.notFound")}</p>
        <Link to="/projects" className="mt-2 inline-block text-sm underline">
          {t("blueprint.workspace.backToProjects")}
        </Link>
      </div>
    );
  }
  if (!data.projected) {
    return (
      <div className="grid h-full grid-cols-3 gap-6 p-10">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-44 rounded-lg" />
        ))}
      </div>
    );
  }
  return <Outlet context={{ ...data, projectId } satisfies WorkspaceContext} />;
}
