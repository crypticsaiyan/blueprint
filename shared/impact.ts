import type { CodeAnalysis, CodeImpact, QueryUsage } from "./code-types";
import { activeItems, type ChangeItem } from "./changes";

const singular = (name: string) =>
  name.endsWith("ies") ? `${name.slice(0, -3)}y` : name.endsWith("s") ? name.slice(0, -1) : name;

const writesColumn = (usage: QueryUsage, column: string) =>
  usage.columns.includes(column);

/**
 * Predicts which queries a changeset breaks or should be reviewed, from the
 * parsed usages. Tests confirm it; this only points at the code.
 */
export function computeImpact(analysis: CodeAnalysis, items: ChangeItem[]): CodeImpact[] {
  const impacts: CodeImpact[] = [];
  const push = (usage: QueryUsage, item: ChangeItem, severity: CodeImpact["severity"], reason: string) =>
    impacts.push({
      usageId: usage.id,
      module: usage.module,
      function: usage.function,
      line: usage.line,
      table: usage.table,
      operation: usage.operation,
      severity,
      itemId: item.id,
      reason,
      snippet: usage.snippet,
      approximate: usage.approximate,
    });

  for (const item of activeItems(items)) {
    const p = item.payload;
    const on = (table: string) => analysis.usages.filter((u) => u.table === table);
    switch (p.kind) {
      case "add_column": {
        const required = !p.column.nullable && !p.column.default;
        for (const usage of on(p.table)) {
          if (usage.operation === "insert" && required && !writesColumn(usage, p.column.name)) {
            push(usage, item, "breaks", `Inserts into ${p.table} must now set ${p.column.name} (NOT NULL, no default).`);
          } else if (p.column.references && usage.kind === "read" && required) {
            push(usage, item, "review", `${p.table} rows now belong to one ${singular(p.column.references.table)}; scope this query by ${p.column.name}?`);
          }
        }
        break;
      }
      case "set_not_null":
        for (const usage of on(p.table)) {
          if (usage.operation === "insert" && !writesColumn(usage, p.column)) {
            push(usage, item, "breaks", `Inserts into ${p.table} must now set ${p.column} (NOT NULL).`);
          } else if (usage.operation === "update" && writesColumn(usage, p.column)) {
            push(usage, item, "review", `Updates to ${p.table}.${p.column} can no longer write NULL.`);
          }
        }
        break;
      case "add_unique":
        for (const usage of on(p.table)) {
          if (usage.operation === "insert" || (usage.operation === "update" && p.columns.some((c) => writesColumn(usage, c)))) {
            push(usage, item, "review", `Writes can fail on a duplicate ${p.columns.join(", ")}${p.caseInsensitive ? " (case-insensitive)" : ""}.`);
          }
        }
        break;
      case "add_foreign_key":
        for (const usage of on(p.table)) {
          if (usage.operation === "insert" || (usage.operation === "update" && writesColumn(usage, p.column))) {
            push(usage, item, "review", `${p.table}.${p.column} must now point at an existing ${p.refTable} row.`);
          }
        }
        break;
      case "drop_foreign_key": {
        const joined = new Set(
          analysis.usages
            .filter((u) => u.table === p.refTable)
            .map((u) => `${u.module}:${u.function}`),
        );
        for (const usage of on(p.table)) {
          if (joined.has(`${usage.module}:${usage.function}`)) {
            push(usage, item, "review", `Joins ${p.table} to ${p.refTable}, a link Postgres will no longer enforce.`);
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return impacts;
}

export function moduleSeverity(impacts: CodeImpact[]) {
  const out = new Map<string, CodeImpact["severity"]>();
  for (const impact of impacts) {
    if (out.get(impact.module) !== "breaks") out.set(impact.module, impact.severity);
  }
  return out;
}
