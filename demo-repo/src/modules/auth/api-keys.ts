import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../../db/client";
import { apiKeys, users } from "../../db/schema";

export async function listApiKeys(db: Db, userId: string) {
  return db
    .select({ id: apiKeys.id, name: apiKeys.name, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(apiKeys.name);
}

export async function resolveApiKey(db: Db, tokenHash: string) {
  const [row] = await db
    .select({ keyId: apiKeys.id, userId: users.id, email: users.email })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(eq(apiKeys.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function unusedApiKeys(db: Db) {
  return db
    .select({ id: apiKeys.id, userId: apiKeys.userId })
    .from(apiKeys)
    .where(and(isNull(apiKeys.lastUsedAt)));
}
