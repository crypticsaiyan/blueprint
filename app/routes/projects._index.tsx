import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { IconBrandGithub, IconChevronRight, IconPackage } from "@tabler/icons-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export function meta() {
  return [{ title: "Projects · Blueprint" }];
}

export default function ProjectsRoute() {
  const t = useT();
  useSetPageTitle(t("blueprint.projects.heading"));
  const navigate = useNavigate();
  const [repoUrl, setRepoUrl] = useState("");
  const projects = useActionQuery("list-projects", {});
  const importRepo = useActionMutation("import-repo", {
    onSuccess: (result) => {
      toast.success(result.message);
      navigate(`/projects/${encodeURIComponent(result.id)}`);
    },
    onError: (error) => toast.error(actionErrorMessage(error) ?? t("blueprint.projects.importFailed")),
  });
  const pendingSource = importRepo.isPending ? importRepo.variables?.source : null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-10">
      <section className="grid gap-4 md:grid-cols-2">
        <form
          className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (repoUrl.trim()) importRepo.mutate({ source: "github", repoUrl: repoUrl.trim() });
          }}
        >
          <Label htmlFor="repo-url" className="flex items-center gap-2">
            <IconBrandGithub className="size-4" />
            {t("blueprint.projects.repoUrlLabel")}
          </Label>
          <Input
            id="repo-url"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder={t("blueprint.projects.repoUrlPlaceholder")}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">{t("blueprint.projects.dumpHint")}</p>
          <Button type="submit" className="mt-auto self-start" disabled={!repoUrl.trim() || importRepo.isPending}>
            {pendingSource === "github" ? t("blueprint.projects.importing") : t("blueprint.projects.importRepo")}
          </Button>
        </form>
        <div className="flex flex-col gap-3 rounded-xl border border-dashed border-ghost/50 bg-ghost/5 p-5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <IconPackage className="size-4 text-ghost" />
            {t("blueprint.projects.demoName")}
          </p>
          <p className="text-sm text-muted-foreground">{t("blueprint.projects.demoDescription")}</p>
          <Button
            variant="outline"
            className="mt-auto self-start"
            disabled={importRepo.isPending}
            onClick={() => importRepo.mutate({ source: "demo" })}
          >
            {pendingSource === "demo" ? t("blueprint.projects.importing") : t("blueprint.projects.useDemo")}
          </Button>
        </div>
      </section>

      <section>
        {projects.isPending ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : projects.data?.projects.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {projects.data.projects.map((project) => (
              <li key={project.id}>
                <Link
                  to={`/projects/${encodeURIComponent(project.id)}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/60"
                >
                  <span className="font-mono text-sm font-medium">{project.name}</span>
                  {project.source === "demo" ? (
                    <span className="rounded bg-ghost/15 px-1.5 py-0.5 text-[10px] font-medium text-ghost">
                      {t("blueprint.projects.demoBadge")}
                    </span>
                  ) : project.repoUrl ? (
                    <span className="truncate text-xs text-muted-foreground">{project.repoUrl}</span>
                  ) : null}
                  <span className="ms-auto text-xs text-muted-foreground">
                    {t("blueprint.projects.tables", { count: project.tables })}
                  </span>
                  <time className="text-xs tabular-nums text-muted-foreground" dateTime={project.createdAt}>
                    {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
                      new Date(project.createdAt),
                    )}
                  </time>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("blueprint.projects.empty")}</p>
        )}
      </section>
    </div>
  );
}
