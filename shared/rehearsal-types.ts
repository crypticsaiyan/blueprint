import type { SchemaSnapshot } from "./schema-types";

export type ConflictKind = "null_values" | "duplicates" | "orphans";

export type FixId =
  | "fill_value"
  | "delete_rows"
  | "skip"
  | "merge_duplicates"
  | "rename_duplicates"
  | "set_null";

export interface FixOption {
  id: FixId;
  label: string;
  description: string;
  needsValue?: boolean | undefined;
}

export interface Resolution {
  key: string;
  fix: FixId;
  value?: string | undefined;
}

export interface ConflictReport {
  key: string;
  itemId: string;
  kind: ConflictKind;
  table: string;
  columns: string[];
  rowCount: number;
  groups?: number | undefined;
  message: string;
  stepLabel: string;
  sampleColumns: string[];
  sampleRows: Record<string, unknown>[];
  rowKeys: string[];
  fixes: FixOption[];
  resolution?: Resolution | null | undefined;
  fixResult?: string | undefined;
}

export type StepStatus = "ok" | "fixed" | "conflict" | "skipped" | "error";

export interface StepResult {
  index: number;
  itemId: string;
  label: string;
  sql: string;
  phase: number;
  status: StepStatus;
  rowsAffected?: number | undefined;
  durationMs: number;
  error?: string | undefined;
  conflictKey?: string | undefined;
  fixDetail?: string | undefined;
}

export interface RowDiff {
  key: string;
  status: "same" | "changed" | "added" | "deleted";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changed: string[];
}

export interface TableDiff {
  table: string;
  isNew: boolean;
  columns: string[];
  newColumns: string[];
  primaryKey: string[];
  counts: { same: number; changed: number; added: number; deleted: number };
  rowCountBefore: number;
  rowCountAfter: number;
  rows: RowDiff[];
}

export interface RehearsalResult {
  status: "passed" | "conflicts" | "failed";
  steps: StepResult[];
  conflicts: ConflictReport[];
  tables: TableDiff[];
  schemaAfter: SchemaSnapshot;
  durationMs: number;
  measured?: {
    table: string;
    column: string;
    total: number;
    filled: number;
    empty: number;
  };
}
