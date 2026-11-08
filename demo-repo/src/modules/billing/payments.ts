import { eq, sum } from "drizzle-orm";

import type { Db } from "../../db/client";
import { invoices, payments } from "../../db/schema";

export async function recordPayment(
  db: Db,
  input: {
    id: string;
    invoiceId: string;
    amountCents: number;
    method: string;
    paidAt: Date;
  },
) {
  return db.transaction(async (tx) => {
    const [payment] = await tx.insert(payments).values(input).returning();
    const [{ paid }] = await tx
      .select({ paid: sum(payments.amountCents) })
      .from(payments)
      .where(eq(payments.invoiceId, input.invoiceId));
    const [invoice] = await tx
      .select({ total: invoices.totalCents })
      .from(invoices)
      .where(eq(invoices.id, input.invoiceId));
    if (invoice && Number(paid) >= invoice.total) {
      await tx
        .update(invoices)
        .set({ status: "paid" })
        .where(eq(invoices.id, input.invoiceId));
    }
    return payment;
  });
}

export async function paymentsForInvoice(db: Db, invoiceId: string) {
  return db
    .select()
    .from(payments)
    .where(eq(payments.invoiceId, invoiceId))
    .orderBy(payments.paidAt);
}
