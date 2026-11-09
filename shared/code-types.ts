// The code side of the map, produced by a language adapter.

export interface CodeModule {
  /** Repo-relative path, e.g. src/modules/billing/invoices.ts */
  path: string;
  label: string;
  /** Repo-relative paths of other modules this one imports. */
  imports: { path: string; line: number }[];
}

export type UsageKind = "read" | "write";
export type UsageOperation = "select" | "join" | "insert" | "update" | "delete" | "raw" | "reference";

export interface QueryUsage {
  id: string;
  module: string;
  function: string;
  line: number;
  table: string;
  columns: string[];
  kind: UsageKind;
  operation: UsageOperation;
  snippet: string;
  /** True when found by text search rather than by parsing queries. */
  approximate: boolean;
}

export interface CodeAnalysis {
  adapter: "typescript-drizzle" | "prisma" | "supabase-js" | "text-search";
  approximate: boolean;
  /** The main schema file: new tables go here unless they belong with a parent. */
  schemaFile: string | null;
  /** Every file defining tables, when the schema is split across files. */
  schemaFiles?: string[] | undefined;
  modules: CodeModule[];
  usages: QueryUsage[];
  analyzedAt: string;
}

export type ImpactSeverity = "breaks" | "review";

export interface CodeImpact {
  usageId: string;
  module: string;
  function: string;
  line: number;
  table: string;
  operation: UsageOperation;
  severity: ImpactSeverity;
  itemId: string;
  reason: string;
  snippet: string;
  approximate: boolean;
}
