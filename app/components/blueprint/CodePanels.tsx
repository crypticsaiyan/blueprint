import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import { actionErrorMessage, useActionMutation } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { IconAlertTriangle, IconArrowRight, IconBan, IconSparkles } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CodeAnalysis, CodeImpact, QueryUsage } from "@shared/code-types";

import { violatesRule, type Rule } from "./MapCanvas";

function UsageRow({ usage, impacts, showModule }: { usage: QueryUsage; impacts: CodeImpact[]; showModule?: boolean }) {
  const mine = impacts.filter((i) => i.usageId === usage.id);
  const worst = mine.some((i) => i.severity === "breaks") ? "breaks" : mine.length ? "review" : null;
  return (
    <li
      className={cn(
        "rounded-md border px-2 py-1.5",
        worst === "breaks" ? "border-conflict/50 bg-conflict/5" : worst === "review" ? "border-ghost/40 bg-ghost/5" : "border-transparent",
      )}
    >
      <p className="flex items-center gap-1.5 font-mono text-[11.5px]">
        {worst === "breaks" ? <IconAlertTriangle className="size-3 shrink-0 text-conflict" /> : null}
        <span className="truncate">
          {showModule ? `${usage.module.replace(/^src\//, "")}:` : "line "}
          {usage.line}
        </span>
        <span className="text-muted-foreground">{usage.function}()</span>
        <span className="ms-auto shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {usage.operation} {usage.table}
        </span>
      </p>
      {usage.columns.length ? (
        <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">{usage.columns.join(", ")}</p>
      ) : null}
      {mine.map((impact) => (
        <p
          key={impact.itemId + impact.reason}
          className={cn("mt-0.5 text-[11px]", impact.severity === "breaks" ? "text-conflict" : "text-ghost")}
        >
          {impact.reason}
        </p>
      ))}
    </li>
  );
}

export function ModuleDetail({ path, code, impacts, rules }: { path: string; code: CodeAnalysis; impacts: CodeImpact[]; rules: Rule[] }) {
  const t = useT();
  const module = code.modules.find((m) => m.path === path);
  const usages = code.usages.filter((u) => u.module === path);
  const broken = impacts.filter((i) => i.module === path && i.severity === "breaks").length;
  return (
    <section className="space-y-3 border-b border-border p-4">
      <div>
        <h2 className="truncate font-mono text-sm font-semibold">{module?.label ?? path}</h2>
        <p className="text-xs text-muted-foreground">
          {t("blueprint.code.queries", { count: usages.length })}
          {code.approximate ? ` · ${t("blueprint.code.approximate")}` : ""}
        </p>
      </div>
      {broken ? (
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() =>
            sendToAgentChat({ message: t("blueprint.code.fixModulePrompt", { path }), submit: true, openSidebar: true })
          }
        >
          <IconSparkles className="size-3.5 text-ghost" />
          {t("blueprint.code.fixModule")}
        </Button>
      ) : null}
      <ul className="-mx-2 space-y-1">
        {usages.map((usage) => (
          <UsageRow key={usage.id} usage={usage} impacts={impacts} />
        ))}
      </ul>
      {module?.imports.length ? (
        <div>
          <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("blueprint.code.imports")}
          </h3>
          <ul className="space-y-0.5 font-mono text-[11.5px]">
            {module.imports.map((dep) => (
              <li key={dep.path} className={cn(violatesRule(rules, path, dep.path) && "text-fill")}>
                {dep.path.replace(/^src\//, "")} <span className="text-muted-foreground">:{dep.line}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function TableQueries({ table, code, impacts }: { table: string; code: CodeAnalysis; impacts: CodeImpact[] }) {
  const t = useT();
  const usages = code.usages.filter((u) => u.table === table);
  if (!usages.length) return null;
  return (
    <div>
      <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("blueprint.code.queries", { count: usages.length })}
      </h3>
      <ul className="-mx-2 space-y-1">
        {usages.map((usage) => (
          <UsageRow key={usage.id} usage={usage} impacts={impacts} showModule />
        ))}
      </ul>
    </div>
  );
}

export function DepDetail({
  projectId,
  from,
  to,
  code,
  rules,
}: {
  projectId: string;
  from: string;
  to: string;
  code: CodeAnalysis;
  rules: Rule[];
}) {
  const t = useT();
  const [reason, setReason] = useState("");
  const line = code.modules.find((m) => m.path === from)?.imports.find((i) => i.path === to)?.line;
  const violation = violatesRule(rules, from, to);
  const addRule = useActionMutation("add-rule", {
    onSuccess: (result) => {
      toast.success(result.message);
      sendToAgentChat({
        message: t("blueprint.code.fixRulePrompt", { from, to }),
        submit: true,
        openSidebar: true,
      });
    },
    onError: (error) => toast.error(actionErrorMessage(error) ?? t("blueprint.code.ruleFailed")),
  });
  return (
    <section className="space-y-3 border-b border-border p-4">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("blueprint.code.dependency")}</h3>
      <p className={cn("flex flex-wrap items-center gap-1.5 font-mono text-xs", violation && "text-fill")}>
        {from.replace(/^src\//, "")}
        <IconArrowRight className="size-3.5" />
        {to.replace(/^src\//, "")}
      </p>
      {line ? <p className="font-mono text-xs text-muted-foreground">{from}:{line}</p> : null}
      {violation ? (
        <p className="text-xs text-fill">{t("blueprint.code.forbidden")}</p>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            addRule.mutate({ projectId, fromModule: from, toModule: to, reason: reason.trim() });
          }}
        >
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("blueprint.code.ruleReason")}
            aria-label={t("blueprint.code.ruleReason")}
            className="h-8 text-xs"
          />
          <Button type="submit" size="sm" variant="outline" className="gap-1.5" disabled={addRule.isPending}>
            <IconBan className="size-3.5" />
            {t("blueprint.code.forbid")}
          </Button>
        </form>
      )}
    </section>
  );
}
