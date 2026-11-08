import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listComments } from "../src/modules/comments/comments";
import { monthlyRevenue, outstandingByCustomer } from "../src/modules/reports/revenue";
import type { Db } from "../src/db/client";
import { createTestDb } from "./db";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("reports", () => {
  it("sums collected revenue per owner and month", async () => {
    const rows = await monthlyRevenue(db);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.collectedCents > 0)).toBe(true);
  });

  it("lists outstanding balances, largest first", async () => {
    const rows = await outstandingByCustomer(db);
    const amounts = rows.map((row) => row.outstandingCents);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  });
});

describe("comments", () => {
  it("returns comments with their author", async () => {
    const rows = await listComments(db, "inv_08");
    expect(rows.every((row) => typeof row.author === "string")).toBe(true);
  });
});
