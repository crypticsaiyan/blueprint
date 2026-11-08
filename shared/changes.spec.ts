import { describe, expect, it } from "vitest";

import {
  backfillSqlForPath,
  changePayloadSchema,
  compileMigration,
  findBackfillPath,
  projectSchema,
  validateAgainst,
  type ChangeItem,
} from "./changes";
import type { SchemaSnapshot } from "./schema-types";

const col = (name: string, nullable = false) => ({ name, type: "text", nullable, default: null });
const snapshot: SchemaSnapshot = {
  tables: [
    { name: "users", columns: [col("id"), col("email")], primaryKey: ["id"], uniques: [], foreignKeys: [], indexes: [], rowCount: 3 },
    {
      name: "customers",
      columns: [col("id"), col("owner_id")],
      primaryKey: ["id"],
      uniques: [],
      foreignKeys: [{ name: "customers_owner_id_fkey", columns: ["owner_id"], refTable: "users", refColumns: ["id"], onDelete: "no action" }],
      indexes: [],
      rowCount: 2,
    },
    { name: "invoices", columns: [col("id"), col("customer_id")], primaryKey: ["id"], uniques: [], foreignKeys: [], indexes: [], rowCount: 5 },
  ],
};

let n = 0;
function item(payload: unknown, status: ChangeItem["status"] = "proposed"): ChangeItem {
  const parsed = changePayloadSchema.parse(payload);
  n += 1;
  return { id: `i${n}`, kind: parsed.kind, payload: parsed, reason: "", status, locked: false, origin: "agent", position: n };
}

describe("compileMigration", () => {
  it("adds required columns nullable, backfills, then enforces NOT NULL", () => {
    const items = [
      item({ kind: "add_column", table: "users", column: { name: "org_id", type: "text", nullable: false } }),
      item({ kind: "backfill", table: "users", column: "org_id", sql: "UPDATE users SET org_id = 'x'" }),
    ];
    const steps = compileMigration(items, snapshot);
    expect(steps.map((s) => s.label)).toEqual([
      "Add column users.org_id",
      "Backfill users.org_id",
      "Enforce users.org_id NOT NULL",
    ]);
    expect(steps[0]!.sql).not.toContain("NOT NULL");
    expect(steps[2]!.check).toEqual({ type: "not_null", table: "users", column: "org_id" });
  });

  it("runs parent backfills before child backfills regardless of item order", () => {
    const items = [
      item({ kind: "add_column", table: "customers", column: { name: "org_id", type: "text" } }),
      item({ kind: "backfill", table: "customers", sql: "UPDATE customers SET org_id = 'c'" }),
      item({ kind: "add_column", table: "users", column: { name: "org_id", type: "text" } }),
      item({ kind: "backfill", table: "users", sql: "UPDATE users SET org_id = 'u'" }),
    ];
    const backfills = compileMigration(items, snapshot).filter((s) => s.phase === 3);
    expect(backfills.map((s) => s.label)).toEqual(["Backfill users", "Backfill customers"]);
  });

  it("leaves rejected items out", () => {
    const steps = compileMigration([item({ kind: "add_index", table: "users", columns: ["email"] }, "rejected")]);
    expect(steps).toEqual([]);
  });
});

describe("validateAgainst", () => {
  it("rejects references to tables that do not exist yet", () => {
    const projected = projectSchema(snapshot, []);
    expect(
      validateAgainst(projected, changePayloadSchema.parse({ kind: "add_foreign_key", table: "users", column: "id", refTable: "orgs", refColumn: "id" })),
    ).toMatch(/orgs/);
  });

  it("accepts references to tables created earlier in the plan", () => {
    const projected = projectSchema(snapshot, [
      item({ kind: "create_table", table: "orgs", columns: [{ name: "id", type: "text", primaryKey: true }] }),
    ]);
    expect(
      validateAgainst(projected, changePayloadSchema.parse({ kind: "add_column", table: "users", column: { name: "org_id", type: "text", references: { table: "orgs", column: "id" } } })),
    ).toBeNull();
  });
});

describe("findBackfillPath", () => {
  it("follows foreign keys, including proposed ones, to a table that already points at the target", () => {
    const items = [
      item({ kind: "create_table", table: "orgs", columns: [{ name: "id", type: "text", primaryKey: true }] }),
      item({ kind: "add_column", table: "users", column: { name: "org_id", type: "text", references: { table: "orgs", column: "id" } } }),
      item({ kind: "add_foreign_key", table: "invoices", column: "customer_id", refTable: "customers", refColumn: "id" }),
    ];
    const path = findBackfillPath(projectSchema(snapshot, items), "invoices", "orgs");
    expect(path?.hops.map((h) => `${h.table}.${h.column}`)).toEqual(["invoices.customer_id", "customers.owner_id"]);
    expect(path?.sourceColumn).toBe("org_id");
    expect(backfillSqlForPath("invoices", "org_id", path!)).toContain(
      'SET "org_id" = t2."org_id"',
    );
  });

  it("returns null when nothing connects", () => {
    expect(findBackfillPath(projectSchema(snapshot, []), "invoices", "users")).toBeNull();
  });
});
