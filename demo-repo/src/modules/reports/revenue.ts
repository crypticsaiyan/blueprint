import { sql } from "drizzle-orm";

import type { Db } from "../../db/client";

export interface RevenueRow {
  ownerId: string;
  month: string;
  collectedCents: number;
}

export async function monthlyRevenue(db: Db): Promise<RevenueRow[]> {
  const result = await db.execute(sql`
    SELECT c.owner_id AS "ownerId",
           to_char(date_trunc('month', p.paid_at), 'YYYY-MM') AS "month",
           SUM(p.amount_cents)::int AS "collectedCents"
    FROM payments p
    JOIN invoices i ON i.id = p.invoice_id
    JOIN customers c ON c.id = i.customer_id
    GROUP BY 1, 2
    ORDER BY 2, 1
  `);
  return (result as unknown as { rows: RevenueRow[] }).rows;
}

export async function outstandingByCustomer(db: Db) {
  const result = await db.execute(sql`
    SELECT i.customer_id AS "customerId",
           SUM(i.total_cents)::int AS "outstandingCents"
    FROM invoices i
    WHERE i.status IN ('sent', 'overdue')
    GROUP BY 1
    ORDER BY 2 DESC
  `);
  return (result as unknown as {
    rows: { customerId: string; outstandingCents: number }[];
  }).rows;
}
