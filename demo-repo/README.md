# Tallyhub

Invoicing for small studios: users own customers, customers have projects and
invoices, invoices have line items, payments, and comments.

This is demo material for [Blueprint](../SPEC.md). The seed data in
`db/dump.sql` is deliberately messy, like a real production database:

- two users signed up twice (`Maya@Tallyhub.io`, `leo@northwind.dev`)
- three customers have no email
- two invoices point at customers that were deleted (`invoices.customer_id`
  has no foreign key)

## Layout

- `src/db/schema.ts`: Drizzle schema
- `src/modules/*`: queries, grouped by feature
- `db/dump.sql`: schema plus seed data (`npm run db:dump` regenerates it)
- `tests/*`: Vitest suite, run against PGlite loaded from `db/dump.sql`
