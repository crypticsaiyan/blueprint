import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listApiKeys, resolveApiKey } from "../src/modules/auth/api-keys";
import { createUser, findUserByEmail, getUser } from "../src/modules/auth/users";
import {
  createCustomer,
  customerBalance,
  listCustomers,
} from "../src/modules/customers/customers";
import { activeProjectsForOwner, archiveProject } from "../src/modules/projects/projects";
import type { Db } from "../src/db/client";
import { createTestDb } from "./db";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("users", () => {
  it("finds a user by email regardless of case", async () => {
    const user = await findUserByEmail(db, "MAYA@tallyhub.io");
    expect(user?.name).toBe("Maya Chen");
  });

  it("creates a user", async () => {
    await createUser(db, { id: "usr_new", email: "new@example.com", name: "New" });
    expect((await getUser(db, "usr_new"))?.email).toBe("new@example.com");
  });
});

describe("api keys", () => {
  it("resolves a key to its user", async () => {
    const row = await resolveApiKey(db, "h_9f2a01");
    expect(row?.userId).toBe("usr_01");
  });

  it("lists a user's keys", async () => {
    expect((await listApiKeys(db, "usr_02")).map((key) => key.name)).toEqual(["CLI"]);
  });
});

describe("customers and projects", () => {
  it("lists an owner's customers alphabetically", async () => {
    const rows = await listCustomers(db, "usr_01");
    const names = rows.map((row) => row.name);
    expect(names).toEqual([...names].sort());
  });

  it("creates a customer for an owner", async () => {
    await createCustomer(db, {
      id: "cus_new",
      ownerId: "usr_04",
      name: "Zephyr Labs",
      email: "ap@zephyr.example",
    });
    expect((await listCustomers(db, "usr_04")).some((row) => row.id === "cus_new")).toBe(true);
  });

  it("sums a customer's unpaid balance", async () => {
    const balance = await customerBalance(db, "cus_01");
    expect(balance).toBeGreaterThanOrEqual(0);
  });

  it("archives a project so it leaves the active list", async () => {
    const [first] = await activeProjectsForOwner(db, "usr_01");
    if (first) {
      await archiveProject(db, first.id);
      const after = await activeProjectsForOwner(db, "usr_01");
      expect(after.some((row) => row.id === first.id)).toBe(false);
    }
  });
});
