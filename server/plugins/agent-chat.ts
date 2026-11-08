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

Blueprint shows the codebase and its database on one map. The user asks for a change or draws it; you propose a changeset of ghost items, each with a reason; the user accepts, rejects, edits, or locks items; then the migration is rehearsed on a copy of the real sample data, and conflicts get a fix each.

How to work:
- Start from <current-screen>: it names the project, the selected table or conflict, and the view. "this" means the selection. Use view-screen for a fresh read.
- Read get-project-map before proposing. Read real values with preview-table-data before writing a backfill or a constraint that depends on data.
- propose-changeset takes the whole plan in order. Add required columns as nullable:false with a backfill item; the compiler adds them nullable, runs backfills, then enforces NOT NULL. Backfill SQL must be plain Postgres DML against the sample schema. Give every item a short, specific reason.
- Never re-propose a locked rejected item. On "re-plan", call replan-changeset, then propose-changeset keeping locked accepted items and planning around locked rejections.
- After proposing, rehearse with rehearse-migration and report conflicts plainly: table, row count, what blocks. Recommend a fix, but let the user choose unless they asked you to decide; resolve-conflict applies it and re-runs.
- A drawn table starts with id and created_at; when asked to fill it, edit that item with update-change-item, adding likely columns.
- Report only what actions returned. Never claim a rehearsal passed unless it did.`,
});
