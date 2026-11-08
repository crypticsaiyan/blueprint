// Writes db/dump.sql: the schema plus seed data, in plain pg_dump style.
// The seed contains real-world mess on purpose: duplicate user emails,
// customers without an email, and invoices whose customer was deleted.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let seed = 20261108;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pad = (n) => String(n).padStart(2, "0");

const users = [
  ["usr_01", "maya@tallyhub.io", "Maya Chen", "2025-01-04T09:12:00Z"],
  ["usr_02", "leo@northwind.dev", "Leo Park", "2025-01-11T15:40:00Z"],
  ["usr_03", "priya@acme.co", "Priya Raman", "2025-02-02T08:05:00Z"],
  ["usr_04", "sam@okafor.studio", "Sam Okafor", "2025-02-19T11:30:00Z"],
  ["usr_05", "Maya@Tallyhub.io", "Maya Chen", "2025-03-01T10:00:00Z"],
  ["usr_06", "jonas@weber.de", "Jonas Weber", "2025-03-14T13:22:00Z"],
  ["usr_07", "ana@souza.design", "Ana Souza", "2025-04-08T17:45:00Z"],
  ["usr_08", "leo@northwind.dev", "Leo Park", "2025-04-21T09:00:00Z"],
  ["usr_09", "ines@duarte.pt", "Ines Duarte", "2025-05-30T12:10:00Z"],
  ["usr_10", "tom@becker.io", "Tom Becker", "2025-06-17T16:35:00Z"],
  ["usr_11", "kofi@mensah.gh", "Kofi Mensah", "2025-07-03T07:50:00Z"],
  ["usr_12", "rin@sato.jp", "Rin Sato", "2025-08-12T14:15:00Z"],
];

const customerNames = [
  ["Brightline Dental", "billing@brightline.example"],
  ["Copperleaf Cafe", "hello@copperleaf.example"],
  ["Driftwood Surf Co", null],
  ["Evergreen Legal", "ap@evergreen.example"],
  ["Foxglove Florals", "orders@foxglove.example"],
  ["Granite Fitness", "accounts@granite.example"],
  ["Harbor Freight Lines", null],
  ["Indigo Print Shop", "print@indigo.example"],
  ["Juniper Health", "finance@juniper.example"],
  ["Kestrel Robotics", "ap@kestrel.example"],
  ["Lumen Architects", "studio@lumen.example"],
  ["Mosaic Bakery", null],
  ["Nimbus Analytics", "billing@nimbus.example"],
  ["Orchard Vet Clinic", "front@orchard.example"],
  ["Pinecrest Realty", "office@pinecrest.example"],
  ["Quarry Brewing", "taproom@quarry.example"],
];
// Owners include both duplicate accounts (usr_05, usr_08) so merging them
// has to repoint real customer rows.
const owners = [
  "usr_01", "usr_02", "usr_03", "usr_05", "usr_04", "usr_06", "usr_07",
  "usr_08", "usr_09", "usr_10", "usr_11", "usr_12", "usr_01", "usr_03",
  "usr_02", "usr_08",
];
const customers = customerNames.map(([name, email], i) => [
  `cus_${pad(i + 1)}`,
  owners[i],
  name,
  email,
  `2025-${pad(1 + Math.floor(i / 2))}-${pad(5 + i)}T10:00:00Z`,
]);

const projectNames = [
  "Website refresh", "Q3 retainer", "Brand kit", "Booking system",
  "Menu redesign", "Mobile app", "SEO audit", "Data warehouse",
  "Shop launch", "Annual report", "Signage", "Onboarding flow",
];
const projects = projectNames.map((name, i) => [
  `prj_${pad(i + 1)}`,
  customers[(i * 3) % customers.length][0],
  name,
  i % 5 === 4 ? "archived" : "active",
]);

const services = [
  ["Design hours", 9500],
  ["Development hours", 12000],
  ["Hosting (monthly)", 4900],
  ["Strategy workshop", 80000],
  ["Copywriting", 7500],
  ["Photography day", 145000],
  ["Support retainer", 60000],
];

const invoices = [];
const items = [];
const payments = [];
for (let i = 1; i <= 40; i++) {
  const id = `inv_${pad(i)}`;
  let customerId = pick(customers)[0];
  // Two invoices point at customers that were hard-deleted years ago.
  if (i === 17) customerId = "cus_98";
  if (i === 33) customerId = "cus_99";
  const ownProjects = projects.filter((p) => p[1] === customerId);
  const projectId = ownProjects.length && rand() > 0.4 ? pick(ownProjects)[0] : null;
  const month = 1 + ((i - 1) % 10);
  const issuedAt = `2026-${pad(month)}-${pad(between(1, 25))}T09:00:00Z`;
  const dueAt = `2026-${pad(Math.min(month + 1, 12))}-${pad(between(1, 25))}T09:00:00Z`;
  const status = pick(["draft", "sent", "paid", "paid", "paid", "overdue"]);
  let total = 0;
  const lineCount = between(1, 3);
  for (let l = 1; l <= lineCount; l++) {
    const [description, unit] = pick(services);
    const quantity = unit > 50000 ? 1 : between(2, 30);
    total += quantity * unit;
    items.push([`itm_${pad(i)}_${l}`, id, description, quantity, unit]);
  }
  invoices.push([id, customerId, projectId, `INV-${1000 + i}`, status, total, issuedAt, dueAt]);
  if (status === "paid") {
    payments.push([
      `pay_${pad(i)}`,
      id,
      total,
      pick(["card", "ach", "wire"]),
      `2026-${pad(Math.min(month + 1, 12))}-${pad(between(1, 28))}T12:00:00Z`,
    ]);
  }
}

const commentBodies = [
  "Sent a reminder to the client.",
  "Client asked for itemized hours.",
  "Paid via bank transfer, waiting to clear.",
  "Discount approved by Maya.",
  "Resent with updated PO number.",
  "Client disputes the hosting line.",
  "Moved due date after call.",
];
const comments = [];
for (let i = 1; i <= 20; i++) {
  comments.push([
    `cmt_${pad(i)}`,
    invoices[(i * 7) % invoices.length][0],
    pick(users)[0],
    pick(commentBodies),
    `2026-${pad(1 + (i % 10))}-${pad(between(1, 28))}T15:00:00Z`,
  ]);
}

const apiKeys = [
  ["key_01", "usr_01", "Zapier", "h_9f2a01", "2026-10-30T08:00:00Z"],
  ["key_02", "usr_02", "CLI", "h_77b1c2", "2026-10-28T19:20:00Z"],
  ["key_03", "usr_03", "Accounting sync", "h_31cc03", null],
  ["key_04", "usr_05", "Old laptop", "h_08de04", "2025-06-01T10:00:00Z"],
  ["key_05", "usr_07", "Webhooks", "h_5a7e05", "2026-11-01T06:45:00Z"],
  ["key_06", "usr_08", "CLI", "h_c4f106", null],
  ["key_07", "usr_10", "Reporting", "h_e02a07", "2026-09-12T11:11:00Z"],
  ["key_08", "usr_12", "Mobile", "h_1bb908", "2026-11-05T21:30:00Z"],
];

function lit(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}
function inserts(table, columns, rows) {
  return rows
    .map(
      (row) =>
        `INSERT INTO public.${table} (${columns.join(", ")}) VALUES (${row.map(lit).join(", ")});`,
    )
    .join("\n");
}

const schema = `--
-- Tallyhub database dump (demo data for Blueprint)
--

CREATE TABLE public.users (
    id text NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_pkey PRIMARY KEY (id)
);

CREATE TABLE public.customers (
    id text NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customers_pkey PRIMARY KEY (id),
    CONSTRAINT customers_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id)
);

CREATE TABLE public.projects (
    id text NOT NULL,
    customer_id text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT projects_pkey PRIMARY KEY (id),
    CONSTRAINT projects_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id)
);

CREATE TABLE public.invoices (
    id text NOT NULL,
    customer_id text NOT NULL,
    project_id text,
    number text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    total_cents integer DEFAULT 0 NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    due_at timestamp with time zone NOT NULL,
    CONSTRAINT invoices_pkey PRIMARY KEY (id),
    CONSTRAINT invoices_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);

CREATE TABLE public.invoice_items (
    id text NOT NULL,
    invoice_id text NOT NULL,
    description text NOT NULL,
    quantity integer NOT NULL,
    unit_cents integer NOT NULL,
    CONSTRAINT invoice_items_pkey PRIMARY KEY (id),
    CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id)
);

CREATE TABLE public.payments (
    id text NOT NULL,
    invoice_id text NOT NULL,
    amount_cents integer NOT NULL,
    method text NOT NULL,
    paid_at timestamp with time zone NOT NULL,
    CONSTRAINT payments_pkey PRIMARY KEY (id),
    CONSTRAINT payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id)
);

CREATE TABLE public.comments (
    id text NOT NULL,
    invoice_id text NOT NULL,
    author_id text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT comments_pkey PRIMARY KEY (id),
    CONSTRAINT comments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id),
    CONSTRAINT comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id)
);

CREATE TABLE public.api_keys (
    id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    last_used_at timestamp with time zone,
    CONSTRAINT api_keys_pkey PRIMARY KEY (id),
    CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);

CREATE INDEX invoices_customer_id_idx ON public.invoices USING btree (customer_id);
CREATE INDEX invoice_items_invoice_id_idx ON public.invoice_items USING btree (invoice_id);
`;

const data = [
  inserts("users", ["id", "email", "name", "created_at"], users),
  inserts("customers", ["id", "owner_id", "name", "email", "created_at"], customers),
  inserts("projects", ["id", "customer_id", "name", "status"], projects),
  inserts(
    "invoices",
    ["id", "customer_id", "project_id", "number", "status", "total_cents", "issued_at", "due_at"],
    invoices,
  ),
  inserts("invoice_items", ["id", "invoice_id", "description", "quantity", "unit_cents"], items),
  inserts("payments", ["id", "invoice_id", "amount_cents", "method", "paid_at"], payments),
  inserts("comments", ["id", "invoice_id", "author_id", "body", "created_at"], comments),
  inserts("api_keys", ["id", "user_id", "name", "token_hash", "last_used_at"], apiKeys),
].join("\n\n");

writeFileSync(join(root, "db/dump.sql"), `${schema}\n--\n-- Data\n--\n\n${data}\n`);
console.log(
  `db/dump.sql: ${users.length} users, ${customers.length} customers, ${projects.length} projects, ${invoices.length} invoices, ${items.length} items, ${payments.length} payments, ${comments.length} comments, ${apiKeys.length} api keys`,
);
