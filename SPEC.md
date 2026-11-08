# Blueprint

See and safely ship database changes across your whole codebase, together with an agent.

Blueprint is a web app that shows a TypeScript codebase and its Postgres database on one map. You ask for a database change (or draw it), steer the agent's plan, rehearse the migration on real data, fix the code it breaks, and open one PR.

## Hackathon

- Event: Builder.io Agent-Native Hackathon. Rules: https://www.builder.io/hackathon/rules
- Deadline: Monday Nov 9, 2026, 11:59 PM PT (Tue Nov 10, 1:29 PM IST). Target submit: Tue Nov 10, 9:00 AM IST.
- Must be built on Agent-Native (`@agent-native/core`), capabilities defined with `defineAction()`.
- Must include a public Clips demo (clips.agent-native.com), viewable without login.
- Submit at https://www.builder.io/hackathon/submit. Disclose pre-existing work: Agent-Native Chat template, libraries, and the demo repo we build.
- No fabricated demos. Everything shown must really run.
- Rubric: Usefulness and Execution 40%, Creativity and Design 20%, Innovation 20%, Cleverness and Use of Agent-Native 20%. Ties broken by Usefulness first.

## Users

Developers on TypeScript apps using Postgres and Drizzle. Example job: "Add multi-tenant orgs without breaking production."

## Input and output

- Input: a GitHub repo plus a sample data dump or seed script.
- Output: a PR with SQL migration, backfill, updated Drizzle schema, fixed queries, and passing tests.

## Screens

1. Import: paste repo URL or pick the bundled demo repo. Map builds automatically.
2. Map:
   - Canvas: code modules on top, tables below. Lines show which module reads or writes which table.
   - Right panel: inspector for the selected item, plus agent chat.
   - Bottom panel: data preview and rehearsal results.
3. Rehearse: before and after rows, conflicts in red, a fix choice for each.
4. Ship: full diff, test results, Create PR button.

## Core flow

1. User asks "add multi-tenant orgs", or draws the change on canvas.
2. Agent proposes a changeset, shown as dotted ghost tables and columns, each with a reason. Affected code modules glow.
3. User accepts, rejects, edits, or locks each ghost. Agent re-plans around locked items.
4. Rehearse runs the migration on a copy of the data in PGlite. Rows visibly transform.
5. Conflicts appear (duplicates blocking a unique constraint, nulls breaking NOT NULL, orphaned foreign keys). User picks a fix for each.
6. Agent fixes broken queries, then the repo's tests run against the migrated database.
7. Create PR.

## Drawing (core, step 1)

- Draw table: sketch a box and name it. Agent fills likely columns as ghosts.
- Draw relationship: drag a line between tables. Agent proposes foreign key, migration, and backfill; affected code glows.
- Delete relationship: agent shows dependent rows and queries before anything changes.
- Every drawing goes through the same rehearsal.

## Actions

Each is one `defineAction()`, used by both UI and agent.

| Action | Does |
|---|---|
| `import-repo` | Read schema from Postgres, parse code, build map |
| `propose-changeset` | Create ghost changes with reasons |
| `draw-table` / `draw-relationship` / `delete-relationship` | Canvas drawing, creates change items |
| `update-change-item` | Accept, reject, edit, or lock one item |
| `replan-changeset` | Redo plan, keeping locked items |
| `find-code-impact` | List affected queries with file and line |
| `rehearse-migration` | Run migration on a data copy, report results and conflicts |
| `resolve-conflict` | Apply the chosen fix to conflicting rows |
| `fix-queries` | Rewrite broken queries |
| `run-tests` | Run repo tests against the migrated database |
| `add-rule` | Save a forbidden module dependency as a CI check (stretch) |
| `create-pr` | Open a PR with all changes |

Application state tracks the selected table or module and the current changeset, so "fix this" always points at the right thing.

## Data stored

Projects, map nodes and edges, changesets, change items, rehearsals, conflicts, test runs, rules.

## Language support

- Database side is language-agnostic: schema is read from Postgres itself (dump or dev database), not from ORM files. Map, drawing, ghosts, rehearsal, conflicts, and migration SQL work for any Postgres app.
- Code side sits behind an adapter interface: find queries, fix queries, update schema file, run tests. First and only adapter for the hackathon: TypeScript plus Drizzle.
- Unsupported languages fall back to text search for table names, labeled "approximate".

## Build plan

Each step leaves a complete, demoable app.

| Step | Result |
|---|---|
| 1 | Import demo repo, database map, drawing, ghost changes, locks, rehearsal on data |
| 2 | Code layer: read-only impact lines, broken queries highlighted |
| 3 | Agent fixes queries, tests run, PR created |
| 4 (stretch) | Delete arrow between code modules creates a rule; agent proposes a fix for violations in the demo repo, tests must pass |

## Demo repo

Small SaaS app we build: about 8 tables, seed data with deliberate conflicts (for example duplicate emails), and real tests. Disclosed as demo material.

## Out of scope

- Databases other than Postgres, ORMs other than Drizzle, code languages other than TypeScript.
- Connecting to live production databases.
- Arbitrary architecture refactors.

## Demo script (about 2.5 minutes)

1. 0:00 Problem: migrations are scary because you can't see impact.
2. 0:15 Import repo, map appears.
3. 0:30 Ask for multi-tenant orgs. Ghosts and glowing code appear.
4. 0:55 Draw a line from `invoices` to `orgs`. Agent shows migration, backfill count, affected queries. Reject and lock one ghost; agent re-plans.
5. 1:15 Rehearse. Rows transform, conflicts glow red, user fixes them.
6. 1:45 Agent fixes queries, tests turn green.
7. 2:10 PR opens. Close with what Agent-Native made possible.

## Tech

- Agent-Native, starting from its Chat template.
- PGlite for app data and rehearsal copies.
- Pending user approval before install: React Flow (`@xyflow/react`), `ts-morph`, Octokit.
- Use the cheapest model that works during development.
