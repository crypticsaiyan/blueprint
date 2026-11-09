import { readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { changePayloadSchema, type ChangeItem } from "../../shared/changes";
import { patchDump, splitStatements } from "./dump-patch";
import { introspect } from "./introspect";
import { rehearse } from "./rehearse";
import { cloneSource, sourceDb } from "./sandbox";

const DUMP = path.resolve(__dirname, "../../demo-repo/db/dump.sql");

let n = 0;
function item(payload: unknown): ChangeItem {
  const parsed = changePayloadSchema.parse(payload);
  n += 1;
  return { id: `p${n}`, kind: parsed.kind, payload: parsed, reason: "", status: "accepted", locked: false, origin: "agent", position: n };
}

describe("splitStatements", () => {
  it("ignores semicolons inside strings, identifiers, comments and dollar quotes", () => {
    const sql = `-- head; comment\nINSERT INTO t VALUES ('a;b', "c;d");\n/* x; */ SELECT $$e;f$$;\ntrailing`;
    const { statements, tail } = splitStatements(sql);
    expect(statements.map((s) => s.body)).toEqual([`INSERT INTO t VALUES ('a;b', "c;d");`, "SELECT $$e;f$$;"]);
    expect(statements[0]!.lead).toBe("-- head; comment\n");
    expect(tail).toBe("\ntrailing");
  });
});

describe("patchDump", () => {
  it("edits the demo dump in place, leaving untouched rows byte for byte", async () => {
    const items = [
      item({ kind: "create_table", table: "orgs", columns: [{ name: "id", type: "text", nullable: false, primaryKey: true }, { name: "name", type: "text", nullable: false }] }),
      item({ kind: "backfill", table: "orgs", sql: "INSERT INTO orgs (id, name) VALUES ('org_1', 'Tallyhub')" }),
      item({ kind: "add_column", table: "customers", column: { name: "org_id", type: "text", nullable: false } }),
      item({ kind: "backfill", table: "customers", column: "org_id", sql: "UPDATE customers SET org_id = 'org_1'" }),
      item({ kind: "add_foreign_key", table: "customers", column: "org_id", refTable: "orgs", refColumn: "id" }),
      item({ kind: "add_unique", table: "users", columns: ["email"], caseInsensitive: true }),
      item({ kind: "add_foreign_key", table: "invoices", column: "customer_id", refTable: "customers", refColumn: "id" }),
    ];
    const pg = await cloneSource("patch-spec", DUMP);
    try {
      const snapshot = await introspect(pg);
      const first = await rehearse({ pg: await cloneSource("patch-spec", DUMP), items, snapshot, resolutions: [] });
      const resolutions = first.conflicts.map((c) => ({
        key: c.key,
        fix: c.kind === "duplicates" ? ("merge_duplicates" as const) : ("delete_rows" as const),
      }));
      const result = await rehearse({ pg, items, snapshot, resolutions });
      expect(result.status).toBe("passed");

      const original = await readFile(DUMP, "utf8");
      const patched = await patchDump(original, await sourceDb("patch-spec", DUMP), pg);
      expect(patched).not.toBeNull();

      const before = original.split("\n");
      const after = new Set(patched!.split("\n"));
      const removed = before.filter((line) => !after.has(line));
      // Only the rows the migration touched change: customers gain org_id,
      // the duplicate users and orphaned invoices (with their children) go.
      expect(removed.length).toBeLessThan(60);
      for (const line of before.filter((l) => l.startsWith("INSERT INTO public.projects"))) {
        expect(after.has(line)).toBe(true);
      }
      expect(patched).toContain("CREATE TABLE public.orgs");
      expect(patched).toContain("ADD CONSTRAINT customers_org_id_fkey");

      const reloaded = new PGlite();
      await reloaded.exec(patched!);
      const counts = await reloaded.query<{ n: number }>("SELECT count(*)::int AS n FROM customers WHERE org_id = 'org_1'");
      expect(counts.rows[0]!.n).toBe(16);
      await reloaded.close();
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe("patchDump on a hand-written schema", () => {
  const schema = `-- Billing tables, kept by hand.
create table plans (
  -- Plan id from Stripe, e.g. plan_1234 (the user's plan).
  id text primary key,
  name text not null -- shown on the pricing page
);

create policy "read plans" on plans for select using (true);
`;

  it("edits the CREATE TABLE in place, keeping comments and other statements", async () => {
    const before = new PGlite();
    await before.exec(schema);
    const after = await before.clone();
    await after.exec("ALTER TABLE plans ADD COLUMN tier text; ALTER TABLE plans ALTER COLUMN tier SET NOT NULL;");
    const out = await patchDump(schema, before, after);
    expect(out).toBe(schema.replace("not null -- shown on the pricing page\n", "not null, -- shown on the pricing page\n  tier text NOT NULL\n"));
    await Promise.all([before.close(), after.close()]);
  });
});
