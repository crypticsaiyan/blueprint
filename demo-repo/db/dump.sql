--
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

--
-- Data
--

INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_01', 'maya@tallyhub.io', 'Maya Chen', '2025-01-04T09:12:00Z');
INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_02', 'leo@northwind.dev', 'Leo Park', '2025-01-11T15:40:00Z');
INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_03', 'priya@acme.co', 'Priya Raman', '2025-02-02T08:05:00Z');
INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_04', 'sam@okafor.studio', 'Sam Okafor', '2025-02-19T11:30:00Z');
INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_05', 'Maya@Tallyhub.io', 'Maya Chen', '2025-03-01T10:00:00Z');
INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_06', 'jonas@weber.de', 'Jonas Weber', '2025-03-14T13:22:00Z');
INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_07', 'ana@souza.design', 'Ana Souza', '2025-04-08T17:45:00Z');
INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_08', 'leo@northwind.dev', 'Leo Park', '2025-04-21T09:00:00Z');
INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_09', 'ines@duarte.pt', 'Ines Duarte', '2025-05-30T12:10:00Z');
INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_10', 'tom@becker.io', 'Tom Becker', '2025-06-17T16:35:00Z');
INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_11', 'kofi@mensah.gh', 'Kofi Mensah', '2025-07-03T07:50:00Z');
INSERT INTO public.users (id, email, name, created_at) VALUES ('usr_12', 'rin@sato.jp', 'Rin Sato', '2025-08-12T14:15:00Z');

INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_01', 'usr_01', 'Brightline Dental', 'billing@brightline.example', '2025-01-05T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_02', 'usr_02', 'Copperleaf Cafe', 'hello@copperleaf.example', '2025-01-06T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_03', 'usr_03', 'Driftwood Surf Co', NULL, '2025-02-07T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_04', 'usr_05', 'Evergreen Legal', 'ap@evergreen.example', '2025-02-08T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_05', 'usr_04', 'Foxglove Florals', 'orders@foxglove.example', '2025-03-09T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_06', 'usr_06', 'Granite Fitness', 'accounts@granite.example', '2025-03-10T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_07', 'usr_07', 'Harbor Freight Lines', NULL, '2025-04-11T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_08', 'usr_08', 'Indigo Print Shop', 'print@indigo.example', '2025-04-12T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_09', 'usr_09', 'Juniper Health', 'finance@juniper.example', '2025-05-13T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_10', 'usr_10', 'Kestrel Robotics', 'ap@kestrel.example', '2025-05-14T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_11', 'usr_11', 'Lumen Architects', 'studio@lumen.example', '2025-06-15T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_12', 'usr_12', 'Mosaic Bakery', NULL, '2025-06-16T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_13', 'usr_01', 'Nimbus Analytics', 'billing@nimbus.example', '2025-07-17T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_14', 'usr_03', 'Orchard Vet Clinic', 'front@orchard.example', '2025-07-18T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_15', 'usr_02', 'Pinecrest Realty', 'office@pinecrest.example', '2025-08-19T10:00:00Z');
INSERT INTO public.customers (id, owner_id, name, email, created_at) VALUES ('cus_16', 'usr_08', 'Quarry Brewing', 'taproom@quarry.example', '2025-08-20T10:00:00Z');

INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_01', 'cus_01', 'Website refresh', 'active');
INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_02', 'cus_04', 'Q3 retainer', 'active');
INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_03', 'cus_07', 'Brand kit', 'active');
INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_04', 'cus_10', 'Booking system', 'active');
INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_05', 'cus_13', 'Menu redesign', 'archived');
INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_06', 'cus_16', 'Mobile app', 'active');
INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_07', 'cus_03', 'SEO audit', 'active');
INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_08', 'cus_06', 'Data warehouse', 'active');
INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_09', 'cus_09', 'Shop launch', 'active');
INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_10', 'cus_12', 'Annual report', 'archived');
INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_11', 'cus_15', 'Signage', 'active');
INSERT INTO public.projects (id, customer_id, name, status) VALUES ('prj_12', 'cus_02', 'Onboarding flow', 'active');

INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_01', 'cus_11', NULL, 'INV-1001', 'paid', 145000, '2026-01-19T09:00:00Z', '2026-02-14T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_02', 'cus_05', NULL, 'INV-1002', 'paid', 205000, '2026-02-04T09:00:00Z', '2026-03-05T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_03', 'cus_14', NULL, 'INV-1003', 'draft', 66500, '2026-03-01T09:00:00Z', '2026-04-17T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_04', 'cus_05', NULL, 'INV-1004', 'paid', 249500, '2026-04-02T09:00:00Z', '2026-05-19T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_05', 'cus_02', NULL, 'INV-1005', 'sent', 191500, '2026-05-03T09:00:00Z', '2026-06-05T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_06', 'cus_09', 'prj_09', 'INV-1006', 'paid', 160000, '2026-06-12T09:00:00Z', '2026-07-04T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_07', 'cus_04', NULL, 'INV-1007', 'sent', 210000, '2026-07-22T09:00:00Z', '2026-08-14T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_08', 'cus_12', 'prj_10', 'INV-1008', 'paid', 205000, '2026-08-07T09:00:00Z', '2026-09-05T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_09', 'cus_01', 'prj_01', 'INV-1009', 'paid', 164000, '2026-09-19T09:00:00Z', '2026-10-05T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_10', 'cus_02', NULL, 'INV-1010', 'paid', 80000, '2026-10-24T09:00:00Z', '2026-11-05T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_11', 'cus_09', 'prj_09', 'INV-1011', 'paid', 202500, '2026-01-16T09:00:00Z', '2026-02-13T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_12', 'cus_04', NULL, 'INV-1012', 'paid', 205000, '2026-02-21T09:00:00Z', '2026-03-12T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_13', 'cus_13', NULL, 'INV-1013', 'paid', 305000, '2026-03-06T09:00:00Z', '2026-04-10T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_14', 'cus_01', 'prj_01', 'INV-1014', 'paid', 300000, '2026-04-18T09:00:00Z', '2026-05-12T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_15', 'cus_02', 'prj_12', 'INV-1015', 'paid', 60000, '2026-05-05T09:00:00Z', '2026-06-10T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_16', 'cus_04', 'prj_02', 'INV-1016', 'sent', 152000, '2026-06-17T09:00:00Z', '2026-07-22T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_17', 'cus_98', NULL, 'INV-1017', 'paid', 214000, '2026-07-23T09:00:00Z', '2026-08-13T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_18', 'cus_09', NULL, 'INV-1018', 'paid', 225000, '2026-08-07T09:00:00Z', '2026-09-04T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_19', 'cus_09', 'prj_09', 'INV-1019', 'overdue', 253500, '2026-09-21T09:00:00Z', '2026-10-21T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_20', 'cus_11', NULL, 'INV-1020', 'paid', 80000, '2026-10-22T09:00:00Z', '2026-11-19T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_21', 'cus_11', NULL, 'INV-1021', 'draft', 421000, '2026-01-09T09:00:00Z', '2026-02-12T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_22', 'cus_04', 'prj_02', 'INV-1022', 'sent', 282500, '2026-02-12T09:00:00Z', '2026-03-15T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_23', 'cus_10', NULL, 'INV-1023', 'draft', 60000, '2026-03-15T09:00:00Z', '2026-04-22T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_24', 'cus_09', 'prj_09', 'INV-1024', 'paid', 303000, '2026-04-08T09:00:00Z', '2026-05-09T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_25', 'cus_16', NULL, 'INV-1025', 'paid', 397500, '2026-05-17T09:00:00Z', '2026-06-18T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_26', 'cus_10', 'prj_04', 'INV-1026', 'draft', 80000, '2026-06-01T09:00:00Z', '2026-07-03T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_27', 'cus_02', 'prj_12', 'INV-1027', 'sent', 140000, '2026-07-03T09:00:00Z', '2026-08-17T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_28', 'cus_07', 'prj_03', 'INV-1028', 'overdue', 145000, '2026-08-14T09:00:00Z', '2026-09-24T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_29', 'cus_02', 'prj_12', 'INV-1029', 'overdue', 285000, '2026-09-13T09:00:00Z', '2026-10-19T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_30', 'cus_04', 'prj_02', 'INV-1030', 'draft', 252000, '2026-10-02T09:00:00Z', '2026-11-04T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_31', 'cus_11', NULL, 'INV-1031', 'paid', 60000, '2026-01-17T09:00:00Z', '2026-02-08T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_32', 'cus_03', 'prj_07', 'INV-1032', 'paid', 388500, '2026-02-23T09:00:00Z', '2026-03-04T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_33', 'cus_99', NULL, 'INV-1033', 'paid', 332500, '2026-03-10T09:00:00Z', '2026-04-07T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_34', 'cus_12', NULL, 'INV-1034', 'overdue', 80000, '2026-04-17T09:00:00Z', '2026-05-25T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_35', 'cus_12', 'prj_10', 'INV-1035', 'paid', 620500, '2026-05-04T09:00:00Z', '2026-06-13T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_36', 'cus_12', 'prj_10', 'INV-1036', 'paid', 395500, '2026-06-11T09:00:00Z', '2026-07-24T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_37', 'cus_07', NULL, 'INV-1037', 'sent', 281000, '2026-07-18T09:00:00Z', '2026-08-02T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_38', 'cus_09', NULL, 'INV-1038', 'overdue', 220000, '2026-08-22T09:00:00Z', '2026-09-24T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_39', 'cus_10', NULL, 'INV-1039', 'draft', 432500, '2026-09-02T09:00:00Z', '2026-10-20T09:00:00Z');
INSERT INTO public.invoices (id, customer_id, project_id, number, status, total_cents, issued_at, due_at) VALUES ('inv_40', 'cus_11', NULL, 'INV-1040', 'overdue', 113000, '2026-10-16T09:00:00Z', '2026-11-15T09:00:00Z');

INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_01_1', 'inv_01', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_02_1', 'inv_02', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_02_2', 'inv_02', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_03_1', 'inv_03', 'Design hours', 7, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_04_1', 'inv_04', 'Design hours', 11, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_04_2', 'inv_04', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_05_1', 'inv_05', 'Copywriting', 11, 7500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_05_2', 'inv_05', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_05_3', 'inv_05', 'Hosting (monthly)', 10, 4900);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_06_1', 'inv_06', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_06_2', 'inv_06', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_07_1', 'inv_07', 'Copywriting', 28, 7500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_08_1', 'inv_08', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_08_2', 'inv_08', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_09_1', 'inv_09', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_09_2', 'inv_09', 'Design hours', 2, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_10_1', 'inv_10', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_11_1', 'inv_11', 'Copywriting', 27, 7500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_12_1', 'inv_12', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_12_2', 'inv_12', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_13_1', 'inv_13', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_13_2', 'inv_13', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_13_3', 'inv_13', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_14_1', 'inv_14', 'Development hours', 25, 12000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_15_1', 'inv_15', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_16_1', 'inv_16', 'Design hours', 16, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_17_1', 'inv_17', 'Hosting (monthly)', 10, 4900);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_17_2', 'inv_17', 'Copywriting', 22, 7500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_18_1', 'inv_18', 'Copywriting', 22, 7500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_18_2', 'inv_18', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_19_1', 'inv_19', 'Design hours', 18, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_19_2', 'inv_19', 'Copywriting', 11, 7500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_20_1', 'inv_20', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_21_1', 'inv_21', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_21_2', 'inv_21', 'Development hours', 23, 12000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_22_1', 'inv_22', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_22_2', 'inv_22', 'Design hours', 15, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_22_3', 'inv_22', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_23_1', 'inv_23', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_24_1', 'inv_24', 'Development hours', 14, 12000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_24_2', 'inv_24', 'Copywriting', 18, 7500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_25_1', 'inv_25', 'Copywriting', 15, 7500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_25_2', 'inv_25', 'Copywriting', 30, 7500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_25_3', 'inv_25', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_26_1', 'inv_26', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_27_1', 'inv_27', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_27_2', 'inv_27', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_28_1', 'inv_28', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_29_1', 'inv_29', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_29_2', 'inv_29', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_29_3', 'inv_29', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_30_1', 'inv_30', 'Development hours', 21, 12000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_31_1', 'inv_31', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_32_1', 'inv_32', 'Development hours', 17, 12000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_32_2', 'inv_32', 'Design hours', 11, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_32_3', 'inv_32', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_33_1', 'inv_33', 'Design hours', 14, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_33_2', 'inv_33', 'Design hours', 21, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_34_1', 'inv_34', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_35_1', 'inv_35', 'Development hours', 23, 12000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_35_2', 'inv_35', 'Design hours', 21, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_35_3', 'inv_35', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_36_1', 'inv_36', 'Design hours', 13, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_36_2', 'inv_36', 'Strategy workshop', 1, 80000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_36_3', 'inv_36', 'Development hours', 16, 12000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_37_1', 'inv_37', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_37_2', 'inv_37', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_37_3', 'inv_37', 'Design hours', 8, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_38_1', 'inv_38', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_38_2', 'inv_38', 'Copywriting', 2, 7500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_38_3', 'inv_38', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_39_1', 'inv_39', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_39_2', 'inv_39', 'Copywriting', 19, 7500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_39_3', 'inv_39', 'Photography day', 1, 145000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_40_1', 'inv_40', 'Design hours', 4, 9500);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_40_2', 'inv_40', 'Support retainer', 1, 60000);
INSERT INTO public.invoice_items (id, invoice_id, description, quantity, unit_cents) VALUES ('itm_40_3', 'inv_40', 'Copywriting', 2, 7500);

INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_01', 'inv_01', 145000, 'ach', '2026-02-20T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_02', 'inv_02', 205000, 'card', '2026-03-15T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_04', 'inv_04', 249500, 'wire', '2026-05-25T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_06', 'inv_06', 160000, 'card', '2026-07-03T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_08', 'inv_08', 205000, 'card', '2026-09-24T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_09', 'inv_09', 164000, 'ach', '2026-10-18T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_10', 'inv_10', 80000, 'wire', '2026-11-10T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_11', 'inv_11', 202500, 'wire', '2026-02-12T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_12', 'inv_12', 205000, 'card', '2026-03-01T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_13', 'inv_13', 305000, 'ach', '2026-04-15T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_14', 'inv_14', 300000, 'card', '2026-05-07T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_15', 'inv_15', 60000, 'card', '2026-06-16T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_17', 'inv_17', 214000, 'card', '2026-08-04T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_18', 'inv_18', 225000, 'card', '2026-09-03T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_20', 'inv_20', 80000, 'ach', '2026-11-19T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_24', 'inv_24', 303000, 'ach', '2026-05-03T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_25', 'inv_25', 397500, 'wire', '2026-06-04T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_31', 'inv_31', 60000, 'card', '2026-02-27T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_32', 'inv_32', 388500, 'wire', '2026-03-11T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_33', 'inv_33', 332500, 'card', '2026-04-01T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_35', 'inv_35', 620500, 'wire', '2026-06-10T12:00:00Z');
INSERT INTO public.payments (id, invoice_id, amount_cents, method, paid_at) VALUES ('pay_36', 'inv_36', 395500, 'ach', '2026-07-04T12:00:00Z');

INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_01', 'inv_08', 'usr_01', 'Sent a reminder to the client.', '2026-02-10T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_02', 'inv_15', 'usr_06', 'Client asked for itemized hours.', '2026-03-09T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_03', 'inv_22', 'usr_12', 'Client asked for itemized hours.', '2026-04-11T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_04', 'inv_29', 'usr_02', 'Paid via bank transfer, waiting to clear.', '2026-05-09T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_05', 'inv_36', 'usr_08', 'Client disputes the hosting line.', '2026-06-23T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_06', 'inv_03', 'usr_11', 'Sent a reminder to the client.', '2026-07-10T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_07', 'inv_10', 'usr_06', 'Moved due date after call.', '2026-08-10T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_08', 'inv_17', 'usr_08', 'Resent with updated PO number.', '2026-09-23T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_09', 'inv_24', 'usr_09', 'Discount approved by Maya.', '2026-10-03T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_10', 'inv_31', 'usr_05', 'Moved due date after call.', '2026-01-18T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_11', 'inv_38', 'usr_03', 'Paid via bank transfer, waiting to clear.', '2026-02-20T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_12', 'inv_05', 'usr_11', 'Client disputes the hosting line.', '2026-03-20T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_13', 'inv_12', 'usr_09', 'Paid via bank transfer, waiting to clear.', '2026-04-23T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_14', 'inv_19', 'usr_05', 'Sent a reminder to the client.', '2026-05-21T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_15', 'inv_26', 'usr_03', 'Resent with updated PO number.', '2026-06-20T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_16', 'inv_33', 'usr_03', 'Moved due date after call.', '2026-07-28T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_17', 'inv_40', 'usr_07', 'Paid via bank transfer, waiting to clear.', '2026-08-19T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_18', 'inv_07', 'usr_07', 'Moved due date after call.', '2026-09-24T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_19', 'inv_14', 'usr_07', 'Client disputes the hosting line.', '2026-10-01T15:00:00Z');
INSERT INTO public.comments (id, invoice_id, author_id, body, created_at) VALUES ('cmt_20', 'inv_21', 'usr_10', 'Client asked for itemized hours.', '2026-01-13T15:00:00Z');

INSERT INTO public.api_keys (id, user_id, name, token_hash, last_used_at) VALUES ('key_01', 'usr_01', 'Zapier', 'h_9f2a01', '2026-10-30T08:00:00Z');
INSERT INTO public.api_keys (id, user_id, name, token_hash, last_used_at) VALUES ('key_02', 'usr_02', 'CLI', 'h_77b1c2', '2026-10-28T19:20:00Z');
INSERT INTO public.api_keys (id, user_id, name, token_hash, last_used_at) VALUES ('key_03', 'usr_03', 'Accounting sync', 'h_31cc03', NULL);
INSERT INTO public.api_keys (id, user_id, name, token_hash, last_used_at) VALUES ('key_04', 'usr_05', 'Old laptop', 'h_08de04', '2025-06-01T10:00:00Z');
INSERT INTO public.api_keys (id, user_id, name, token_hash, last_used_at) VALUES ('key_05', 'usr_07', 'Webhooks', 'h_5a7e05', '2026-11-01T06:45:00Z');
INSERT INTO public.api_keys (id, user_id, name, token_hash, last_used_at) VALUES ('key_06', 'usr_08', 'CLI', 'h_c4f106', NULL);
INSERT INTO public.api_keys (id, user_id, name, token_hash, last_used_at) VALUES ('key_07', 'usr_10', 'Reporting', 'h_e02a07', '2026-09-12T11:11:00Z');
INSERT INTO public.api_keys (id, user_id, name, token_hash, last_used_at) VALUES ('key_08', 'usr_12', 'Mobile', 'h_1bb908', '2026-11-05T21:30:00Z');
