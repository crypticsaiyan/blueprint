import {
  createSharesTable,
  ownableColumns,
} from "@agent-native/core/db/schema";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { ChangePayload } from "../../shared/changes.js";
import type { CodeAnalysis } from "../../shared/code-types.js";
import type {
  ConflictReport,
  RehearsalResult,
} from "../../shared/rehearsal-types.js";
import type { SchemaSnapshot } from "../../shared/schema-types.js";

const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`now()`);
const updatedAt = () =>
  text("updated_at")
    .notNull()
    .default(sql`now()`);

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  source: text("source", { enum: ["demo", "github"] }).notNull(),
  repoUrl: text("repo_url"),
  repoPath: text("repo_path").notNull(),
  dumpPath: text("dump_path").notNull(),
  schema: jsonb("schema").$type<SchemaSnapshot>().notNull(),
  code: jsonb("code").$type<CodeAnalysis>(),
  githubRepo: text("github_repo"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ...ownableColumns(),
});
export const projectShares = createSharesTable("project_shares");

export const mapNodes = pgTable(
  "map_nodes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    key: text("key").notNull(),
    kind: text("kind", { enum: ["table", "module"] }).notNull(),
    label: text("label").notNull(),
    x: real("x").notNull(),
    y: real("y").notNull(),
    // Copied from the project so every table is tenant-scoped.
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
  },
  (t) => [uniqueIndex("map_nodes_project_key_idx").on(t.projectId, t.key)],
);

export const mapEdges = pgTable(
  "map_edges",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    kind: text("kind", { enum: ["foreign_key", "reads", "writes"] }).notNull(),
    sourceKey: text("source_key").notNull(),
    targetKey: text("target_key").notNull(),
    label: text("label"),
    // Copied from the project so every table is tenant-scoped.
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
  },
  (t) => [index("map_edges_project_idx").on(t.projectId)],
);

export const changesets = pgTable(
  "changesets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    goal: text("goal").notNull().default(""),
    code: jsonb("code").$type<CodeAnalysis>(),
    status: text("status", { enum: ["open", "shipped"] })
      .notNull()
      .default("open"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Copied from the project so every table is tenant-scoped.
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
  },
  (t) => [index("changesets_project_idx").on(t.projectId, t.status)],
);

export const changeItems = pgTable(
  "change_items",
  {
    id: text("id").primaryKey(),
    changesetId: text("changeset_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<ChangePayload>().notNull(),
    reason: text("reason").notNull().default(""),
    status: text("status", { enum: ["proposed", "accepted", "rejected"] })
      .notNull()
      .default("proposed"),
    locked: boolean("locked").notNull().default(false),
    origin: text("origin", { enum: ["agent", "drawing", "user"] }).notNull(),
    position: integer("position").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Copied from the project so every table is tenant-scoped.
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
  },
  (t) => [index("change_items_changeset_idx").on(t.changesetId, t.position)],
);

export const rehearsals = pgTable(
  "rehearsals",
  {
    id: text("id").primaryKey(),
    changesetId: text("changeset_id").notNull(),
    projectId: text("project_id").notNull(),
    status: text("status", { enum: ["passed", "conflicts", "failed"] }).notNull(),
    sql: text("sql").notNull(),
    result: jsonb("result").$type<RehearsalResult>().notNull(),
    createdAt: createdAt(),
    // Copied from the project so every table is tenant-scoped.
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
  },
  (t) => [index("rehearsals_changeset_idx").on(t.changesetId, t.createdAt)],
);

export const conflicts = pgTable(
  "conflicts",
  {
    id: text("id").primaryKey(),
    changesetId: text("changeset_id").notNull(),
    projectId: text("project_id").notNull(),
    rehearsalId: text("rehearsal_id").notNull(),
    itemId: text("item_id").notNull(),
    key: text("key").notNull(),
    kind: text("kind", { enum: ["null_values", "duplicates", "orphans"] }).notNull(),
    tableName: text("table_name").notNull(),
    rowCount: integer("row_count").notNull(),
    detail: jsonb("detail").$type<ConflictReport>().notNull(),
    fix: text("fix"),
    fixValue: text("fix_value"),
    status: text("status", { enum: ["open", "resolved", "gone"] })
      .notNull()
      .default("open"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Copied from the project so every table is tenant-scoped.
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
  },
  (t) => [uniqueIndex("conflicts_changeset_key_idx").on(t.changesetId, t.key)],
);

export const codeEdits = pgTable(
  "code_edits",
  {
    id: text("id").primaryKey(),
    changesetId: text("changeset_id").notNull(),
    projectId: text("project_id").notNull(),
    path: text("path").notNull(),
    summary: text("summary").notNull(),
    origin: text("origin", { enum: ["agent", "generated", "user"] }).notNull(),
    createdAt: createdAt(),
    // Copied from the project so every table is tenant-scoped.
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
  },
  (t) => [index("code_edits_changeset_idx").on(t.changesetId, t.createdAt)],
);

export type TestCase = { name: string; file: string; status: "passed" | "failed" | "skipped"; message?: string | undefined };

export const testRuns = pgTable(
  "test_runs",
  {
    id: text("id").primaryKey(),
    changesetId: text("changeset_id").notNull(),
    projectId: text("project_id").notNull(),
    status: text("status", { enum: ["passed", "failed", "error"] }).notNull(),
    command: text("command").notNull(),
    total: integer("total").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    cases: jsonb("cases").$type<TestCase[]>().notNull(),
    output: text("output").notNull().default(""),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: createdAt(),
    // Copied from the project so every table is tenant-scoped.
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
  },
  (t) => [index("test_runs_changeset_idx").on(t.changesetId, t.createdAt)],
);

export const rules = pgTable(
  "rules",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    fromModule: text("from_module").notNull(),
    toModule: text("to_module").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: createdAt(),
    // Copied from the project so every table is tenant-scoped.
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
  },
  (t) => [index("rules_project_idx").on(t.projectId)],
);

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: text("id").primaryKey(),
    changesetId: text("changeset_id").notNull(),
    projectId: text("project_id").notNull(),
    url: text("url").notNull(),
    number: integer("number").notNull(),
    branch: text("branch").notNull(),
    createdAt: createdAt(),
    // Copied from the project so every table is tenant-scoped.
    ownerEmail: text("owner_email").notNull(),
    orgId: text("org_id"),
  },
  (t) => [index("pull_requests_changeset_idx").on(t.changesetId)],
);
