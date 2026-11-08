import { runMigrations } from "@agent-native/core/db";

export default runMigrations(
  [
    {
      version: 1,
      name: "blueprint-core",
      sql: `CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  repo_url TEXT,
  repo_path TEXT NOT NULL,
  dump_path TEXT NOT NULL,
  schema JSONB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS project_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (now()),
  notified_at TEXT
);
CREATE TABLE IF NOT EXISTS map_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  owner_email TEXT NOT NULL,
  org_id TEXT
);
CREATE TABLE IF NOT EXISTS map_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  target_key TEXT NOT NULL,
  label TEXT,
  owner_email TEXT NOT NULL,
  org_id TEXT
);
CREATE TABLE IF NOT EXISTS changesets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL,
  org_id TEXT
);
CREATE TABLE IF NOT EXISTS change_items (
  id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed',
  locked BOOLEAN NOT NULL DEFAULT false,
  origin TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL,
  org_id TEXT
);
CREATE TABLE IF NOT EXISTS rehearsals (
  id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  sql TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL,
  org_id TEXT
);
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  rehearsal_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  detail JSONB NOT NULL,
  fix TEXT,
  fix_value TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL,
  org_id TEXT
);
CREATE INDEX IF NOT EXISTS projects_owner_org_idx ON projects (owner_email, org_id, created_at);
CREATE INDEX IF NOT EXISTS project_shares_resource_idx ON project_shares (resource_id, principal_type, principal_id);
CREATE UNIQUE INDEX IF NOT EXISTS map_nodes_project_key_idx ON map_nodes (project_id, key);
CREATE INDEX IF NOT EXISTS map_edges_project_idx ON map_edges (project_id);
CREATE INDEX IF NOT EXISTS changesets_project_idx ON changesets (project_id, status);
CREATE INDEX IF NOT EXISTS change_items_changeset_idx ON change_items (changeset_id, position);
CREATE INDEX IF NOT EXISTS rehearsals_changeset_idx ON rehearsals (changeset_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS conflicts_changeset_key_idx ON conflicts (changeset_id, key)`,
    },
    {
      version: 2,
      name: "blueprint-code-layer",
      sql: `ALTER TABLE projects ADD COLUMN IF NOT EXISTS code JSONB;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo TEXT;
ALTER TABLE changesets ADD COLUMN IF NOT EXISTS code JSONB;
CREATE TABLE IF NOT EXISTS code_edits (
  id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  summary TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL,
  org_id TEXT
);
CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  command TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cases JSONB NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL,
  org_id TEXT
);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_module TEXT NOT NULL,
  to_module TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL,
  org_id TEXT
);
CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  url TEXT NOT NULL,
  number INTEGER NOT NULL,
  branch TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL,
  org_id TEXT
);
CREATE INDEX IF NOT EXISTS code_edits_changeset_idx ON code_edits (changeset_id, created_at);
CREATE INDEX IF NOT EXISTS test_runs_changeset_idx ON test_runs (changeset_id, created_at);
CREATE INDEX IF NOT EXISTS rules_project_idx ON rules (project_id);
CREATE INDEX IF NOT EXISTS pull_requests_changeset_idx ON pull_requests (changeset_id)`,
    },
  ],
  { table: "blueprint_migrations" },
);
