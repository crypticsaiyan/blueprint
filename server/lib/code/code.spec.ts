import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { changePayloadSchema, type ChangeItem } from "../../../shared/changes";
import { computeImpact } from "../../../shared/impact";
import { findViolations } from "../../../shared/rules";
import { introspect } from "../introspect";
import { loadDump } from "../sandbox";
import { generateDrizzleSchema } from "./drizzle-codegen";
import { analyzeCode } from "./index";

const DEMO = path.resolve(__dirname, "../../../demo-repo");
const TSC = path.resolve(__dirname, "../../../node_modules/.bin/tsc");

let n = 0;
function item(payload: unknown): ChangeItem {
  const parsed = changePayloadSchema.parse(payload);
  n += 1;
  return { id: `i${n}`, kind: parsed.kind, payload: parsed, reason: "", status: "accepted", locked: false, origin: "agent", position: n };
}

const orgItems = () => [
  item({ kind: "create_table", table: "orgs", columns: [{ name: "id", type: "text", primaryKey: true }, { name: "name", type: "text", nullable: false }] }),
  item({ kind: "add_column", table: "users", column: { name: "org_id", type: "text", nullable: false, references: { table: "orgs", column: "id" } } }),
  item({ kind: "add_unique", table: "users", columns: ["email"], caseInsensitive: true }),
  item({ kind: "add_foreign_key", table: "invoices", column: "customer_id", refTable: "customers", refColumn: "id" }),
];

async function demoAnalysis() {
  const pg = await loadDump(path.join(DEMO, "db/dump.sql"));
  const snapshot = await introspect(pg);
  await pg.close();
  return analyzeCode(DEMO, snapshot);
}

describe("TypeScript + Drizzle adapter on the demo repo", () => {
  it("finds queries with file, line, table, and columns", async () => {
    const analysis = await demoAnalysis();
    expect(analysis.adapter).toBe("typescript-drizzle");
    expect(analysis.schemaFile).toBe("src/db/schema.ts");
    const insert = analysis.usages.find((u) => u.function === "createUser");
    expect(insert).toMatchObject({ module: "src/modules/auth/users.ts", operation: "insert", table: "users", kind: "write" });
    const join = analysis.usages.find((u) => u.function === "listInvoicesForOwner" && u.table === "customers");
    expect(join?.operation).toBe("join");
    expect(join?.columns).toContain("owner_id");
    const raw = analysis.usages.filter((u) => u.function === "monthlyRevenue").map((u) => u.table).sort();
    expect(raw).toEqual(["customers", "invoices", "payments"]);
    expect(analysis.modules.find((m) => m.path.endsWith("customers.ts"))?.imports.map((i) => i.path)).toEqual([
      "src/modules/billing/invoices.ts",
    ]);
  }, 60_000);

  it("predicts the inserts a new NOT NULL column breaks", async () => {
    const impacts = computeImpact(await demoAnalysis(), orgItems());
    const breaks = impacts.filter((i) => i.severity === "breaks").map((i) => `${i.module}:${i.function}`);
    expect(breaks).toEqual(["src/modules/auth/users.ts:createUser"]);
  }, 60_000);

  it("flags imports that break a dependency rule", async () => {
    const violations = findViolations(await demoAnalysis(), [
      { fromModule: "src/modules/customers", toModule: "src/modules/billing" },
    ]);
    expect(violations).toEqual([
      expect.objectContaining({ from: "src/modules/customers/customers.ts", to: "src/modules/billing/invoices.ts" }),
    ]);
  }, 60_000);
});

describe("Drizzle schema codegen", () => {
  it("writes a schema TypeScript accepts, failing only the inserts impact analysis predicted", () => {
    // Inside the repo so the copy resolves drizzle-orm from node_modules.
    const scratch = path.resolve(__dirname, "../../../.tmp");
    mkdirSync(scratch, { recursive: true });
    const dir = mkdtempSync(path.join(scratch, "codegen-"));
    try {
      cpSync(DEMO, dir, { recursive: true, filter: (src) => !src.includes("node_modules") });
      const schemaPath = path.join(dir, "src/db/schema.ts");
      const next = generateDrizzleSchema(readFileSync(schemaPath, "utf8"), orgItems());
      expect(next).toContain('export const orgs = pgTable("orgs"');
      expect(next).toContain('orgId: text("org_id").notNull().references(() => orgs.id),');
      expect(next).toContain('uniqueIndex("users_email_lower_key").on(sql`lower(${t.email})`)');
      expect(next).toContain('customerId: text("customer_id").notNull().references(() => customers.id),');
      writeFileSync(schemaPath, next);
      let output = "";
      try {
        execFileSync(TSC, ["--noEmit", "-p", "."], { encoding: "utf8", cwd: dir });
      } catch (error) {
        output = String((error as { stdout?: string }).stdout ?? "");
      }
      const files = [...output.matchAll(/^(src\/[^(]+)\(/gm)].map((m) => m[1]);
      expect(files).toEqual(["src/modules/auth/users.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("is a no-op without schema changes", () => {
    const source = readFileSync(path.join(DEMO, "src/db/schema.ts"), "utf8");
    expect(generateDrizzleSchema(source, [item({ kind: "backfill", table: "users", sql: "select 1" })])).toBe(source);
  });
});
