import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getInvoiceWithItems,
  listInvoicesForCustomer,
  listInvoicesForOwner,
  markInvoiceSent,
  overdueInvoices,
} from "../src/modules/billing/invoices";
import { paymentsForInvoice, recordPayment } from "../src/modules/billing/payments";
import type { Db } from "../src/db/client";
import { createTestDb } from "./db";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("invoices", () => {
  it("lists a customer's invoices newest first", async () => {
    const rows = await listInvoicesForCustomer(db, "cus_01");
    const dates = rows.map((row) => row.issuedAt.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(rows.every((row) => row.customerId === "cus_01")).toBe(true);
  });

  it("lists invoices across an owner's customers", async () => {
    const rows = await listInvoicesForOwner(db, "usr_01");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => typeof row.customer === "string")).toBe(true);
  });

  it("loads an invoice with its line items and a matching total", async () => {
    const invoice = await getInvoiceWithItems(db, "inv_01");
    expect(invoice).not.toBeNull();
    const sum = invoice!.items.reduce(
      (total, item) => total + item.quantity * item.unitCents,
      0,
    );
    expect(sum).toBe(invoice!.totalCents);
  });

  it("finds overdue invoices", async () => {
    const rows = await overdueInvoices(db, new Date("2026-12-31T00:00:00Z"));
    expect(rows.every((row) => row.status === "sent" || row.status === "overdue")).toBe(true);
  });

  it("only sends drafts", async () => {
    const [draft] = (await listInvoicesForOwner(db, "usr_01")).filter(
      (row) => row.status === "draft",
    );
    if (draft) {
      expect((await markInvoiceSent(db, draft.id))?.status).toBe("sent");
      expect(await markInvoiceSent(db, draft.id)).toBeNull();
    }
  });
});

describe("payments", () => {
  it("marks an invoice paid once fully paid", async () => {
    const target = (await overdueInvoices(db, new Date("2030-01-01T00:00:00Z")))[0];
    expect(target).toBeDefined();
    await recordPayment(db, {
      id: "pay_test",
      invoiceId: target.id,
      amountCents: target.totalCents,
      method: "card",
      paidAt: new Date("2026-11-01T00:00:00Z"),
    });
    const invoice = await getInvoiceWithItems(db, target.id);
    expect(invoice?.status).toBe("paid");
    expect((await paymentsForInvoice(db, target.id)).length).toBeGreaterThan(0);
  });
});
