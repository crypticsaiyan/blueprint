import { and, desc, eq, inArray, lt } from "drizzle-orm";

import type { Db } from "../../db/client";
import { customers, invoiceItems, invoices } from "../../db/schema";

export async function listInvoicesForCustomer(db: Db, customerId: string) {
  return db
    .select()
    .from(invoices)
    .where(eq(invoices.customerId, customerId))
    .orderBy(desc(invoices.issuedAt));
}

export async function listInvoicesForOwner(db: Db, ownerId: string) {
  return db
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      totalCents: invoices.totalCents,
      customer: customers.name,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(eq(customers.ownerId, ownerId))
    .orderBy(desc(invoices.issuedAt));
}

export async function getInvoiceWithItems(db: Db, id: string) {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!invoice) return null;
  const items = await db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, id))
    .orderBy(invoiceItems.id);
  return { ...invoice, items };
}

export async function overdueInvoices(db: Db, now: Date) {
  return db
    .select()
    .from(invoices)
    .where(
      and(inArray(invoices.status, ["sent", "overdue"]), lt(invoices.dueAt, now)),
    )
    .orderBy(invoices.dueAt);
}

export async function markInvoiceSent(db: Db, id: string) {
  const [row] = await db
    .update(invoices)
    .set({ status: "sent" })
    .where(and(eq(invoices.id, id), eq(invoices.status, "draft")))
    .returning();
  return row ?? null;
}
