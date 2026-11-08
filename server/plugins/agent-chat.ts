import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";
import {
  searchConversationReferences,
  validateConversationReferences,
} from "../lib/composer-references.js";

const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "list-projects",
  "import-repo",
  "get-project-map",
  "preview-table-data",
  "get-changeset",
  "propose-changeset",
  "update-change-item",
  "replan-changeset",
  "draw-table",
  "draw-relationship",
  "delete-relationship",
  "rehearse-migration",
  "resolve-conflict",
  "find-code-impact",
  "read-code-file",
  "fix-queries",
  "run-tests",
  "get-ship-status",
  "create-pr",
  "add-rule",
  "ask-question",
];

export default createAgentChatPlugin({
  appId: "blueprint",
  mentionProviders: {
    chats: {
      label: "composerSources.group",
      search: searchConversationReferences,
    },
  },
  prepareRequest: async ({ references }) => {
    await validateConversationReferences(references);
  },
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  mcp: { connectorCatalog: [], appApprovalPage: true },
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are Blueprint's agent. You help developers see and safely ship Postgres schema changes across a TypeScript codebase.

Blueprint shows the codebase (modules and the queries they run) and its database on one map. The user asks for a change or draws it; you propose a changeset of ghost items, each with a reason; the user accepts, rejects, edits, or locks items; then the migration is rehearsed on a copy of the real sample data, and conflicts get a fix each.

How to work:
- Start from <current-screen>: it names the project, the selected table or conflict, and the view. "this" means the selection. Use view-screen for a fresh read.
- Read get-project-map before proposing. Read real values with preview-table-data before writing a backfill or a constraint that depends on data.
- propose-changeset takes the whole plan in order. Add required columns as nullable:false with a backfill item; the compiler adds them nullable, runs backfills, then enforces NOT NULL. Backfill SQL must be plain Postgres DML against the sample schema. Give every item a short, specific reason.
- Never re-propose a locked rejected item. On "re-plan", call replan-changeset, then propose-changeset keeping locked accepted items and planning around locked rejections.
- After proposing, rehearse with rehearse-migration and report conflicts plainly: table, row count, what blocks. Recommend a fix, but let the user choose unless they asked you to decide; resolve-conflict applies it and re-runs.
- A drawn table starts with id and created_at; when asked to fill it, edit that item with update-change-item, adding likely columns.
- Code: find-code-impact lists queries the plan breaks (file:line). After the rehearsal passes, fix them: read-code-file, then fix-queries with exact find/replace edits, then run-tests (repo tests + typecheck + rules, against the migrated data). Never edit the generated schema, migration, or dump; change the changeset. Update a test only when the data really changed (say why in a comment).
- Rules: add-rule forbids a module dependency. Fix violations the same way (move code, keep behavior), then run-tests.
- Ship: get-ship-status shows the diff and blockers. create-pr only when the user asks; it needs passing rehearsal and tests.
- Report only what actions returned. Never claim a rehearsal passed unless it did.`,
});
