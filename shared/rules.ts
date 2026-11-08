import type { CodeAnalysis } from "./code-types";

export interface DependencyRule {
  fromModule: string;
  toModule: string;
  reason?: string | undefined;
}

export interface RuleViolation {
  from: string;
  to: string;
  line: number;
  rule: DependencyRule;
}

/** Rules match by path prefix: "src/modules/customers" covers the folder. */
export function findViolations(analysis: CodeAnalysis, rules: DependencyRule[]): RuleViolation[] {
  const out: RuleViolation[] = [];
  for (const module of analysis.modules) {
    for (const dep of module.imports) {
      const rule = rules.find((r) => module.path.startsWith(r.fromModule) && dep.path.startsWith(r.toModule));
      if (rule) out.push({ from: module.path, to: dep.path, line: dep.line, rule });
    }
  }
  return out;
}
