import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { useSetHeaderActions, useSetPageTitle } from "@agent-native/toolkit/app-shell";
import {
  IconBrandGithub,
  IconDots,
  IconLoader2,
  IconPackage,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { BlueprintLogo } from "@/components/blueprint/BlueprintLogo";
import { StageLabel } from "@/components/blueprint/StageBadge";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { projectStage } from "@shared/stage";

export function meta() {
  return [{ title: "Projects · Blueprint" }];
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "3 minutes ago", "yesterday", then a plain date past a week. */
function ago(iso: string) {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
    value /= size;
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
}

export default function ProjectsRoute() {
  const t = useT();
  const navigate = useNavigate();
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const deleteProject = useActionMutation("delete-project", {
    onSuccess: (result) => {
      toast.success(result.message);
      setDeleting(null);
    },
    onError: (error) => toast.error(actionErrorMessage(error) ?? t("blueprint.projects.deleteFailed")),
  });
  const projects = useActionQuery("list-projects", {});
  const importRepo = useActionMutation("import-repo", {
    onSuccess: (result) => {
      toast.success(result.message);
      setImporting(false);
      navigate(`/projects/${encodeURIComponent(result.id)}`);
    },
    onError: (error) => toast.error(actionErrorMessage(error) ?? t("blueprint.projects.importFailed")),
  });
  useSetPageTitle(t("blueprint.projects.heading"));
  const list = projects.data?.projects ?? [];
  const hasProjects = list.length > 0;
  useSetHeaderActions(
    useMemo(
      () =>
        hasProjects ? (
          <Button size="sm" className="h-8 gap-1.5" onClick={() => setImporting(true)}>
            <IconPlus className="size-4" />
            {t("blueprint.projects.newProject")}
          </Button>
        ) : null,
      [hasProjects, t],
    ),
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? list.filter((p) => `${p.name} ${p.repoUrl ?? ""}`.toLowerCase().includes(q)) : list;
  }, [list, query]);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      {projects.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : !hasProjects ? (
        <EmptyState
          pending={importRepo.isPending ? (importRepo.variables?.source ?? null) : null}
          onImport={() => setImporting(true)}
          onDemo={() => importRepo.mutate({ source: "demo" })}
        />
      ) : (
        <div className="space-y-4">
          <div className="relative max-w-xs">
            <IconSearch className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("blueprint.projects.search")}
              aria-label={t("blueprint.projects.search")}
              className="h-9 ps-8"
            />
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_6.5rem_2rem] gap-4 border-b border-border bg-muted/40 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:grid">
              <span>{t("blueprint.projects.colProject")}</span>
              <span>{t("blueprint.projects.colSchema")}</span>
              <span>{t("blueprint.projects.colStatus")}</span>
              <span className="text-end">{t("blueprint.projects.colUpdated")}</span>
              <span />
            </div>
            {shown.length ? (
              <ul className="divide-y divide-border">
                {shown.map((project) => {
                  const stage = projectStage(project);
                  const repo = project.repoUrl?.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
                  return (
                    <li key={project.id} className="relative">
                      <Link
                        to={`/projects/${encodeURIComponent(project.id)}`}
                        className="grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_6.5rem_2rem]"
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                            {project.source === "demo" ? (
                              <IconPackage className="size-4 text-muted-foreground" strokeWidth={1.8} />
                            ) : (
                              <IconBrandGithub className="size-4 text-muted-foreground" strokeWidth={1.8} />
                            )}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{project.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {project.goal ?? (project.source === "demo" ? t("blueprint.projects.demoBadge") : repo)}
                            </span>
                          </span>
                        </span>
                        <span className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
                          {t("blueprint.projects.tables", { count: project.tables })}
                          {" · "}
                          {project.schemaSource === "migrations" ? t("blueprint.projects.sourceMigrations") : t("blueprint.projects.sourceDump")}
                          {project.adapter ? ` · ${t(`blueprint.projects.adapter.${project.adapter}`)}` : ""}
                        </span>
                        <StageLabel
                          stage={stage}
                          changes={project.changes}
                          prNumber={project.pullRequest?.number}
                          className="col-start-1 md:col-start-auto"
                        />
                        <time
                          dateTime={project.updatedAt}
                          title={new Date(project.updatedAt).toLocaleString()}
                          className="hidden text-end text-xs tabular-nums text-muted-foreground md:block"
                        >
                          {ago(project.updatedAt)}
                        </time>
                        {/* Room for the menu button, which sits outside the link. */}
                        <span className="row-span-2 md:row-span-1" aria-hidden />
                      </Link>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="absolute end-3 top-1/2 size-8 -translate-y-1/2 text-muted-foreground"
                            aria-label={t("blueprint.projects.actions", { name: project.name })}
                          >
                            <IconDots className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {project.repoUrl ? (
                            <DropdownMenuItem asChild>
                              <a href={project.repoUrl} target="_blank" rel="noreferrer">
                                <IconBrandGithub className="size-4" />
                                {t("blueprint.workspace.openRepo")}
                              </a>
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem
                            className="text-conflict focus:text-conflict"
                            onSelect={() => setDeleting({ id: project.id, name: project.name })}
                          >
                            <IconTrash className="size-4" />
                            {t("blueprint.projects.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t("blueprint.projects.noMatches", { query })}</p>
            )}
          </div>
        </div>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && !deleteProject.isPending && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("blueprint.projects.deleteTitle", { name: deleting?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("blueprint.projects.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteProject.isPending}>{t("blueprint.inspector.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteProject.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (deleting) deleteProject.mutate({ projectId: deleting.id });
              }}
            >
              {deleteProject.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconTrash className="size-4" />}
              {t("blueprint.projects.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ImportDialog
        open={importing}
        onOpenChange={setImporting}
        pending={importRepo.isPending ? (importRepo.variables?.source ?? null) : null}
        onImport={(repoUrl, dumpPath) =>
          importRepo.mutate({ source: "github", repoUrl, ...(dumpPath ? { dumpPath } : {}) })
        }
        onDemo={() => importRepo.mutate({ source: "demo" })}
      />
    </div>
  );
}

function EmptyState({
  pending,
  onImport,
  onDemo,
}: {
  pending: string | null;
  onImport: () => void;
  onDemo: () => void;
}) {
  const t = useT();
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center py-16 text-center">
      <BlueprintLogo className="size-12" />
      <h1 className="mt-5 text-xl font-semibold tracking-tight">{t("blueprint.projects.emptyTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("blueprint.projects.emptyBody")}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button className="gap-1.5" onClick={onImport} disabled={pending !== null}>
          <IconBrandGithub className="size-4" />
          {t("blueprint.projects.newProject")}
        </Button>
        <Button variant="outline" className="gap-1.5" onClick={onDemo} disabled={pending !== null}>
          {pending === "demo" ? <IconLoader2 className="size-4 animate-spin" /> : <IconPackage className="size-4" />}
          {pending === "demo" ? t("blueprint.projects.importing") : t("blueprint.projects.useDemo")}
        </Button>
      </div>
    </div>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  pending,
  onImport,
  onDemo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: string | null;
  onImport: (repoUrl: string, dumpPath: string) => void;
  onDemo: () => void;
}) {
  const t = useT();
  const [repoUrl, setRepoUrl] = useState("");
  const [dumpPath, setDumpPath] = useState("");
  const busy = pending !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("blueprint.projects.importTitle")}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (repoUrl.trim()) onImport(repoUrl.trim(), dumpPath.trim());
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="repo-url">{t("blueprint.projects.repoUrlLabel")}</Label>
            <Input
              id="repo-url"
              autoFocus
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder={t("blueprint.projects.repoUrlPlaceholder")}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">{t("blueprint.projects.dumpHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dump-path">{t("blueprint.projects.dumpPathLabel")}</Label>
            <Input
              id="dump-path"
              value={dumpPath}
              onChange={(e) => setDumpPath(e.target.value)}
              placeholder={t("blueprint.projects.dumpPathPlaceholder")}
              className="font-mono text-sm"
            />
          </div>
          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" className="gap-1.5" disabled={!repoUrl.trim() || busy}>
              {pending === "github" ? <IconLoader2 className="size-4 animate-spin" /> : <IconBrandGithub className="size-4" />}
              {pending === "github" ? t("blueprint.projects.importing") : t("blueprint.projects.importRepo")}
            </Button>
            <span className="text-xs text-muted-foreground">{t("blueprint.projects.orDemo")}</span>
            <Button type="button" variant="ghost" className={cn("gap-1.5")} disabled={busy} onClick={onDemo}>
              {pending === "demo" ? <IconLoader2 className="size-4 animate-spin" /> : <IconPackage className="size-4" />}
              {t("blueprint.projects.useDemo")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
