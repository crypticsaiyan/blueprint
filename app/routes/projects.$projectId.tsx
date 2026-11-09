import { actionErrorMessage, useActionMutation } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { useSetHeaderActions, useSetPageTitle } from "@agent-native/toolkit/app-shell";
import {
  IconAlertTriangle,
  IconAlertTriangleFilled,
  IconArrowRight,
  IconBrandGithub,
  IconCircleCheckFilled,
  IconLoader2,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { Fragment, useMemo } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectData } from "@/lib/blueprint";
import { cn } from "@/lib/utils";
import { projectStage } from "@shared/stage";

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
  const location = useLocation();
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

  const testRun = data.changeset.data?.test ?? null;
  const pullRequest = data.changeset.data?.pullRequest ?? null;
  const changes = data.items.filter((i) => i.status !== "rejected").length;
  const stage = projectStage({
    changes,
    rehearsal: rehearsal ? { status: rehearsal.status, stale: rehearsal.stale } : null,
    test: testRun ? { status: testRun.status, stale: testRun.stale } : null,
    pullRequest,
  });
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const route = location.pathname.endsWith("/ship") ? "ship" : location.pathname.endsWith("/rehearse") ? "rehearse" : "plan";
  const repoHref = project?.repoUrl ?? null;

  useSetPageTitle(
    project ? (
      <span className="flex min-w-0 items-center gap-1.5 text-sm">
        <Link to="/projects" className="text-muted-foreground transition-colors hover:text-foreground">
          {t("blueprint.projects.heading")}
        </Link>
        <span className="text-muted-foreground/60">/</span>
        <span className="truncate font-medium">{project.name}</span>
        {repoHref ? (
          <a
            href={repoHref}
            target="_blank"
            rel="noreferrer"
            aria-label={t("blueprint.workspace.openRepo")}
            className="ms-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <IconBrandGithub className="size-3.5" />
          </a>
        ) : null}
      </span>
    ) : null,
  );

  // Each step shows where it stands; the button offers the next step only.
  const steps = useMemo(() => [
    {
      key: "plan",
      to: base,
      end: true,
      label: t("blueprint.workspace.stepPlan"),
      state: changes ? ("done" as const) : ("todo" as const),
      badge: changes || null,
    },
    {
      key: "rehearse",
      to: `${base}/rehearse`,
      end: false,
      label: t("blueprint.workspace.stepRehearse"),
      state:
        !rehearsal || rehearsal.stale
          ? ("todo" as const)
          : rehearsal.status === "passed"
            ? ("done" as const)
            : ("problem" as const),
      badge: rehearsal && !rehearsal.stale && openConflicts ? openConflicts : null,
    },
    {
      key: "ship",
      to: `${base}/ship`,
      end: false,
      label: t("blueprint.workspace.stepShip"),
      state:
        stage === "pr" || stage === "ready" ? ("done" as const) : stage === "tests_failed" ? ("problem" as const) : ("todo" as const),
      badge: null,
    },
  ], [base, t, changes, rehearsal, openConflicts, stage]);

  const actions = useMemo(() => {
    let primary: React.ReactNode = null;
    if (stage === "pr" && pullRequest) {
      primary = (
        <Button size="sm" variant="outline" className="h-8 gap-1.5" asChild>
          <a href={pullRequest.url} target="_blank" rel="noreferrer">
            <IconBrandGithub className="size-3.5" />
            {t("blueprint.workspace.viewPr", { number: pullRequest.number })}
          </a>
        </Button>
      );
    } else if ((stage === "rehearsed" || stage === "tests_failed" || stage === "ready") && route !== "ship") {
      primary = (
        <Button size="sm" className="h-8 gap-1.5" asChild>
          <Link to={`${base}/ship`}>
            {t("blueprint.workspace.continueToShip")}
            <IconArrowRight className="size-3.5" />
          </Link>
        </Button>
      );
    } else if (stage === "conflicts" && route === "plan") {
      primary = (
        <Button size="sm" className="h-8 gap-1.5" asChild>
          <Link to={`${base}/rehearse`}>
            <IconAlertTriangle className="size-3.5" />
            {t("blueprint.workspace.reviewConflicts")}
          </Link>
        </Button>
      );
    } else if (route !== "ship" || stage === "planning") {
      primary = (
        <Button
          size="sm"
          className="h-8 gap-1.5"
          disabled={!hasItems || rehearse.isPending}
          onClick={() => rehearse.mutate({ projectId })}
        >
          {rehearse.isPending ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconPlayerPlay className="size-3.5" />}
          {rehearse.isPending ? t("blueprint.workspace.rehearsing") : t("blueprint.workspace.rehearse")}
        </Button>
      );
    }
    return (
      <div className="flex items-center gap-3">
        <nav aria-label={t("blueprint.nav")} className="hidden items-center sm:flex">
          {steps.map((step, index) => (
            <Fragment key={step.key}>
              {index > 0 ? <span aria-hidden className="mx-1 h-px w-4 bg-border" /> : null}
              <NavLink
                to={step.to}
                end={step.end}
                className={({ isActive }) =>
                  cn(
                    "flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    isActive && "bg-accent text-foreground",
                  )
                }
              >
                {step.state === "done" ? (
                  <IconCircleCheckFilled className="size-4 text-ok" />
                ) : step.state === "problem" ? (
                  <IconAlertTriangleFilled className="size-4 text-conflict" />
                ) : (
                  <span className="flex size-4 items-center justify-center rounded-full border border-current text-[9px] tabular-nums">
                    {index + 1}
                  </span>
                )}
                {step.label}
                {step.badge ? (
                  <span
                    className={cn(
                      "rounded px-1 text-[10px] tabular-nums",
                      step.state === "problem" ? "bg-conflict/15 text-conflict" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {step.badge}
                  </span>
                ) : null}
              </NavLink>
            </Fragment>
          ))}
        </nav>
        {primary}
      </div>
    );
  }, [steps, stage, route, base, pullRequest, hasItems, rehearse, projectId, t]);
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
