import { eq, sql } from "drizzle-orm";

import type { Db } from "../../db/client";
import { users } from "../../db/schema";

export async function findUserByEmail(db: Db, email: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .orderBy(users.createdAt)
    .limit(1);
  return user ?? null;
}

export async function getUser(db: Db, id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user ?? null;
}

export async function createUser(
  db: Db,
  input: { id: string; email: string; name: string },
) {
  const [user] = await db.insert(users).values(input).returning();
  return user;
}

export async function listUsers(db: Db) {
  return db.select().from(users).orderBy(users.name);
}
