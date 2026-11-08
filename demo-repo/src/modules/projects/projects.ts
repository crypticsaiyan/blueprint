import { and, eq } from "drizzle-orm";

import type { Db } from "../../db/client";
import { customers, projects } from "../../db/schema";

export async function listProjects(db: Db, customerId: string) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.customerId, customerId))
    .orderBy(projects.name);
}

export async function activeProjectsForOwner(db: Db, ownerId: string) {
  return db
    .select({ id: projects.id, name: projects.name, customer: customers.name })
    .from(projects)
    .innerJoin(customers, eq(projects.customerId, customers.id))
    .where(and(eq(customers.ownerId, ownerId), eq(projects.status, "active")))
    .orderBy(projects.name);
}

export async function archiveProject(db: Db, id: string) {
  const [row] = await db
    .update(projects)
    .set({ status: "archived" })
    .where(eq(projects.id, id))
    .returning();
  return row ?? null;
}
