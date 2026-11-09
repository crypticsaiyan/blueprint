# Changelog

All notable user-facing changes to Blueprint are documented here.

## 2026-11-10

- Re-planning keeps the agent's proposals that your drawings or locked items depend on, so a re-plan never leaves a drawn relationship pointing at a table that no longer exists.
- Arrange lays out proposed tables too, so new tables get their own place on the map instead of covering existing ones.
- Dragging a relationship shows a dashed line from the table to the cursor.
- A conflict fixed with "Keep it nullable" now shows which fix was chosen.
- When a code fix doesn't match the file, the agent is told nothing was written and sees the file's real text, so it retries instead of giving up.

## 2026-11-09

- Works on real repos: schemas from Prisma, Drizzle, and Supabase migrations, other Postgres schemas besides `public`, pgvector, and supabase-js queries.
- The Ship page shows test progress, and a running test job can be cancelled.
- Supabase `Database` types and Drizzle schemas are regenerated from the changeset.
- Delete a project from the dashboard.
- New dashboard, plan/rehearse/ship stepper, and monochrome light and dark themes.

## 2026-11-08

- Import a repo or the bundled Tallyhub demo and see its tables and code modules on one map.
- Ask the agent for a change, or draw tables and relationships; proposals appear as ghosts you can accept, reject, lock, or edit.
- Rehearse the migration on a PGlite copy of the sample data, see changed rows and conflicts, and pick a fix for each.
- The agent fixes broken queries, the repo's tests and typecheck run against the migrated data, and one click opens the pull request.
