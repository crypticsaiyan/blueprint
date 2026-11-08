import path from "node:path";

import { describe, expect, it } from "vitest";

import { changePayloadSchema, type ChangeItem } from "../../shared/changes";
import { introspect } from "./introspect";
import { rehearse } from "./rehearse";
import { cloneSource, dropSource } from "./sandbox";

const DUMP = path.resolve(__dirname, "../../demo-repo/db/dump.sql");

let n = 0;
function item(payload: unknown): ChangeItem {
  const parsed = changePayloadSchema.parse(payload);
  n += 1;
  return { id: `i${n}`, kind: parsed.kind, payload: parsed, reason: "", status: "accepted", locked: false, origin: "agent", position: n };
}

async function run(items: ChangeItem[], resolutions: { key: string; fix: "merge_duplicates" | "delete_rows" | "fill_value" | "rename_duplicates" | "skip" | "set_null"; value?: string }[] = []) {
  const pg = await cloneSource("spec", DUMP);
  try {
    const snapshot = await introspect(pg);
    return await rehearse({ pg, items, snapshot, resolutions });
  } finally {
    await pg.close();
  }
}


describe("rehearse on the demo data", () => {
  it("finds the seeded duplicate emails and merges them, repointing references", async () => {
    const unique = item({ kind: "add_unique", table: "users", columns: ["email"], caseInsensitive: true });
    const first = await run([unique]);
    expect(first.status).toBe("conflicts");
    const conflict = first.conflicts[0]!;
    expect(conflict.kind).toBe("duplicates");
    expect(conflict.rowCount).toBe(4);
    expect(conflict.rowKeys.sort()).toEqual(["usr_01", "usr_02", "usr_05", "usr_08"]);

    const fixed = await run([unique], [{ key: conflict.key, fix: "merge_duplicates" }]);
    expect(fixed.status).toBe("passed");
    const users = fixed.tables.find((t) => t.table === "users")!;
    expect(users.counts.deleted).toBe(2);
    const customers = fixed.tables.find((t) => t.table === "customers")!;
    expect(customers.rows.filter((r) => r.status === "changed").every((r) => r.changed.includes("owner_id"))).toBe(true);
  }, 60_000);

  it("reports orphaned invoices for a new foreign key and deletes them with dependents", async () => {
    const fk = item({ kind: "add_foreign_key", table: "invoices", column: "customer_id", refTable: "customers", refColumn: "id" });
    const first = await run([fk]);
    const conflict = first.conflicts[0]!;
    expect(conflict.kind).toBe("orphans");
    expect(conflict.rowKeys.sort()).toEqual(["inv_17", "inv_33"]);
    expect(conflict.fixes.map((f) => f.id)).not.toContain("set_null");

    const fixed = await run([fk], [{ key: conflict.key, fix: "delete_rows" }]);
    expect(fixed.status).toBe("passed");
    expect(fixed.tables.find((t) => t.table === "invoices")!.counts.deleted).toBe(2);
  }, 60_000);

  it("fills NULLs before NOT NULL when asked", async () => {
    const notNull = item({ kind: "set_not_null", table: "customers", column: "email" });
    const first = await run([notNull]);
    expect(first.conflicts[0]!.rowCount).toBe(3);
    const fixed = await run([notNull], [{ key: first.conflicts[0]!.key, fix: "fill_value", value: "unknown@example.com" }]);
    expect(fixed.status).toBe("passed");
    expect(fixed.schemaAfter.tables.find((t) => t.name === "customers")!.columns.find((c) => c.name === "email")!.nullable).toBe(false);
  }, 60_000);

  it("reports a failing backfill as an error instead of passing", async () => {
    const result = await run([item({ kind: "backfill", table: "users", sql: "UPDATE users SET nope = 1" })]);
    expect(result.status).toBe("failed");
    expect(result.steps[0]!.error).toMatch(/nope/);
    dropSource("spec");
  }, 60_000);
});

describe("shipping", () => {
  it("replays the migration with its recorded fixes on a fresh copy, and dumps a loadable database", async () => {
    const { compileMigration, shippableMigrationSql } = await import("../../shared/changes");
    const { dumpDatabase } = await import("./dump");
    const { PGlite } = await import("@electric-sql/pglite");
    const items = [
      item({ kind: "add_unique", table: "users", columns: ["email"], caseInsensitive: true }),
      item({ kind: "add_foreign_key", table: "invoices", column: "customer_id", refTable: "customers", refColumn: "id" }),
    ];
    const first = await run(items);
    const resolutions = first.conflicts.map((c) => ({
      key: c.key,
      fix: c.kind === "duplicates" ? ("merge_duplicates" as const) : ("delete_rows" as const),
    }));
    const pg = await cloneSource("spec", DUMP);
    const snapshot = await introspect(pg);
    const result = await rehearse({ pg, items, snapshot, resolutions });
    expect(result.status).toBe("passed");
    const dump = await dumpDatabase(pg, "spec");
    await pg.close();

    const fresh = await cloneSource("spec", DUMP);
    await fresh.exec(shippableMigrationSql(compileMigration(items, snapshot), result));
    const users = await fresh.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
    expect(users.rows[0]!.n).toBe(10);
    await fresh.close();

    const reloaded = new PGlite();
    await reloaded.exec(dump);
    const after = await introspect(reloaded);
    expect(after.tables.find((t) => t.name === "invoices")!.foreignKeys.some((fk) => fk.refTable === "customers")).toBe(true);
    expect(after.tables.find((t) => t.name === "users")!.uniques.some((u) => u.expression?.includes("lower"))).toBe(true);
    await reloaded.close();
  }, 60_000);
});
