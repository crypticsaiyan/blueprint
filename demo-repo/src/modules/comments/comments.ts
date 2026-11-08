import { asc, eq } from "drizzle-orm";

import type { Db } from "../../db/client";
import { comments, users } from "../../db/schema";

export async function listComments(db: Db, invoiceId: string) {
  return db
    .select({
      id: comments.id,
      body: comments.body,
      author: users.name,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(users, eq(comments.authorId, users.id))
    .where(eq(comments.invoiceId, invoiceId))
    .orderBy(asc(comments.createdAt));
}

export async function addComment(
  db: Db,
  input: { id: string; invoiceId: string; authorId: string; body: string },
) {
  const [row] = await db.insert(comments).values(input).returning();
  return row;
}
