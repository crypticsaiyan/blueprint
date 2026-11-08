import { asc, eq } from "drizzle-orm";

import type { Db } from "../../db/client";
import { customers } from "../../db/schema";

export async function listCustomers(db: Db, ownerId: string) {
  return db
    .select()
    .from(customers)
    .where(eq(customers.ownerId, ownerId))
    .orderBy(asc(customers.name));
}

export async function getCustomer(db: Db, id: string) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, id));
  return customer ?? null;
}

export async function createCustomer(
  db: Db,
  input: { id: string; ownerId: string; name: string; email?: string | null },
) {
  const [customer] = await db.insert(customers).values(input).returning();
  return customer;
}

export async function customersMissingEmail(db: Db) {
  const rows = await db.select().from(customers);
  return rows.filter((row) => !row.email);
}
