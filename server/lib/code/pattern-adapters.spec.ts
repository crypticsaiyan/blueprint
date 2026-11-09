import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { changePayloadSchema, type ChangeItem } from "../../../shared/changes";
import type { SchemaSnapshot } from "../../../shared/schema-types";
import { introspect } from "../introspect";
import { loadReport, loadSql } from "../sandbox";
import { findSchemaSource, materializeSource } from "../schema-source";
import { analyzeCode } from "./index";
import { generatePrismaSchema } from "./prisma-codegen";
import { decodeText, encodeText, generateSupabaseTypes } from "./supabase-types";

const dirs: string[] = [];
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-adapter-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function snapshotOf(sql: string): Promise<SchemaSnapshot> {
  const pg = await loadSql(sql);
  const snap = await introspect(pg);
  await pg.close();
  return snap;
}

let n = 0;
function item(payload: unknown): ChangeItem {
  const parsed = changePayloadSchema.parse(payload);
  n += 1;
  return { id: `i${n}`, kind: parsed.kind, payload: parsed, reason: "", status: "accepted", locked: false, origin: "agent", position: n };
}

const PRISMA_SCHEMA = `datasource db {
  provider = "postgresql"
}

model User {
  id        String   @id
  email     String   @unique
  createdAt DateTime @default(now()) @map("created_at")
  posts     Post[]

  @@map("users")
}
`;
const PRISMA_POST = `model Post {
  id       String @id
  title    String
  authorId String @map("author_id")
  author   User   @relation(fields: [authorId], references: [id])

  @@map("posts")
}
`;
const PRISMA_SQL = `
CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL UNIQUE, created_at timestamp(3) NOT NULL DEFAULT now());
CREATE TABLE posts (id text PRIMARY KEY, title text NOT NULL, author_id text NOT NULL REFERENCES users(id));
`;

describe("Prisma adapter", () => {
  it("maps model calls to tables and argument keys to columns, across schema files", async () => {
    const dir = repo({
      "package.json": JSON.stringify({ dependencies: { "@prisma/client": "6" } }),
      "prisma/schema/schema.prisma": PRISMA_SCHEMA,
      "prisma/schema/post.prisma": PRISMA_POST,
      "src/posts.ts": `import { prisma } from "./db";
export async function createPost(authorId: string) {
  return prisma.post.create({
    data: { title: "Hi", authorId },
  });
}
export const listPosts = () => prisma.post.findMany({ where: { title: "x" } });
export async function save(id: string) {
  await prisma.user.upsert({ where: { id }, create: { id, email: "a" }, update: {} });
}
`,
    });
    const code = await analyzeCode(dir, await snapshotOf(PRISMA_SQL));
    expect(code.adapter).toBe("prisma");
    expect(code.schemaFiles).toEqual(["prisma/schema/post.prisma", "prisma/schema/schema.prisma"]);
    const create = code.usages.find((u) => u.function === "createPost")!;
    expect(create).toMatchObject({ table: "posts", operation: "insert", line: 3 });
    // authorId is mapped to author_id; the relation field `author` is no column.
    expect(create.columns.sort()).toEqual(["author_id", "title"]);
    expect(code.usages.find((u) => u.function === "listPosts")).toMatchObject({ table: "posts", operation: "select", kind: "read" });
    // An upsert inserts new rows, so it must set required columns.
    expect(code.usages.find((u) => u.function === "save")).toMatchObject({ table: "users", operation: "insert" });
  });

  it("updates schema.prisma: fields with @map, required, unique, relations both ways, new models", () => {
    const files = new Map([
      ["prisma/schema.prisma", PRISMA_SCHEMA],
      ["prisma/post.prisma", PRISMA_POST],
    ]);
    const { files: out, notes } = generatePrismaSchema(files, [
      item({ kind: "add_column", table: "posts", column: { name: "published_at", type: "timestamptz" } }),
      item({ kind: "add_column", table: "posts", column: { name: "slug", type: "text", nullable: false } }),
      item({ kind: "add_unique", table: "posts", columns: ["slug"] }),
      item({ kind: "set_not_null", table: "posts", column: "published_at" }),
      item({ kind: "add_index", table: "posts", columns: ["author_id", "title"] }),
      item({
        kind: "create_table",
        table: "comments",
        columns: [
          { name: "id", type: "text", primaryKey: true },
          { name: "post_id", type: "text", nullable: false, references: { table: "posts", column: "id", onDelete: "cascade" } },
          { name: "body", type: "varchar(500)", nullable: false, default: "''" },
        ],
      }),
      item({ kind: "add_unique", table: "users", columns: ["email"], caseInsensitive: true }),
    ]);
    const post = out.get("prisma/post.prisma")!;
    expect(post).toContain('  publishedAt DateTime @map("published_at") @db.Timestamptz(6)');
    expect(post).toContain("  slug     String @unique");
    expect(post).toContain("  comments Comment[]");
    expect(post).not.toContain("@@unique");
    expect(post).toMatch(/ {2}@@index\(\[authorId, title\]\)\n {2}@@map\("posts"\)/);
    const schema = out.get("prisma/schema.prisma")!;
    expect(schema).toContain("model Comment {");
    expect(schema).toContain('  postId String @map("post_id")');
    expect(schema).toContain('  body   String @default("") @db.VarChar(500)');
    expect(schema).toContain("  post   Post   @relation(fields: [postId], references: [id], onDelete: Cascade)");
    expect(schema.trimEnd().endsWith('  @@map("comments")\n}')).toBe(true);
    expect(notes).toEqual([expect.stringContaining("case-insensitive unique on users")]);
  });
});

describe("Prisma relation drops", () => {
  it("removes the relation field and its back-relation, keeping the scalar", () => {
    const files = new Map([
      ["prisma/schema.prisma", PRISMA_SCHEMA],
      ["prisma/post.prisma", PRISMA_POST],
    ]);
    const { files: out, notes } = generatePrismaSchema(files, [
      item({ kind: "drop_foreign_key", table: "posts", column: "author_id", refTable: "users", constraint: "posts_author_id_fkey" }),
    ]);
    expect(notes).toEqual([]);
    const post = out.get("prisma/post.prisma")!;
    expect(post).toContain('authorId String @map("author_id")');
    expect(post).not.toContain("@relation");
    expect(out.get("prisma/schema.prisma")!).not.toContain("Post[]");
  });
});

const SUPABASE_TYPES = `export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  public: {
    Tables: {
      posts: {
        Row: {
          author_id: string
          id: string
          title: string | null
        }
        Insert: {
          author_id: string
          id?: string
          title?: string | null
        }
        Update: {
          author_id?: string
          id?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Enums: {
      plan: "free" | "pro"
    }
  }
}
`;

describe("Supabase types", () => {
  it("adds columns in order, tightens NOT NULL, and drops relationships", async () => {
    const snap = await snapshotOf(PRISMA_SQL);
    const { text, notes } = generateSupabaseTypes(SUPABASE_TYPES, [
      item({ kind: "add_column", table: "posts", column: { name: "plan", type: "plan", nullable: false, default: "'free'" } }),
      item({ kind: "add_column", table: "posts", column: { name: "body", type: "text", nullable: false } }),
      item({ kind: "set_not_null", table: "posts", column: "title" }),
      item({ kind: "drop_foreign_key", table: "posts", column: "author_id", refTable: "users", constraint: "posts_author_id_fkey" }),
      item({ kind: "add_column", table: "missing", column: { name: "x", type: "int" } }),
    ], snap);
    expect(notes).toEqual([expect.stringContaining("missing is not in the Supabase types file")]);
    expect(text).toContain(`        Row: {
          author_id: string
          body: string
          id: string
          plan: Database["public"]["Enums"]["plan"]
          title: string
        }
        Insert: {
          author_id: string
          body: string
          id?: string
          plan?: Database["public"]["Enums"]["plan"]
          title: string
        }`);
    expect(text).toContain("          title?: string\n        }\n        Relationships: []");
  });

  it("round-trips UTF-16 files with CRLF line ends", () => {
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a\r\nb\r\n", "utf16le")]);
    const stored = decodeText(original);
    expect(stored).toMatchObject({ text: "a\nb\n", utf16: true, crlf: true });
    expect(encodeText(stored, stored.text).equals(original)).toBe(true);
  });
});

describe("supabase-js adapter", () => {
  it("reads .from() chains: select lists, written keys, filters, and skips storage buckets", async () => {
    const dir = repo({
      "package.json": JSON.stringify({ dependencies: { "@supabase/supabase-js": "2" } }),
      "lib/data.ts": `export async function load(supabase: any, id: string) {
  const { data } = await supabase
    .from("posts")
    .select("id, title, author_id")
    .eq("author_id", id);
  await supabase.from('users').upsert([{ id, email: "a" }]);
  await supabase.storage.from("posts").upload("a.png", new Blob());
  return data;
}
`,
    });
    const code = await analyzeCode(dir, await snapshotOf(PRISMA_SQL));
    expect(code.adapter).toBe("supabase-js");
    expect(code.usages).toHaveLength(2);
    expect(code.usages[0]).toMatchObject({ table: "posts", operation: "select", function: "load", line: 3 });
    expect(code.usages[0]!.columns.sort()).toEqual(["author_id", "id", "title"]);
    expect(code.usages[1]).toMatchObject({ table: "users", operation: "insert", kind: "write" });
    expect(code.usages[1]!.columns.sort()).toEqual(["email", "id"]);
  });
});

describe("schema sources and the sandbox", () => {
  it("finds nested Prisma migrations and runs each file in its own transaction", async () => {
    const dir = repo({
      "packages/db/prisma/migrations/migration_lock.toml": 'provider = "postgresql"\n',
      "packages/db/prisma/migrations/1_init/migration.sql": `CREATE TYPE "Kind" AS ENUM ('a');\nCREATE TABLE "Thing" ("id" TEXT PRIMARY KEY, "kind" "Kind" NOT NULL)`,
      // Using an enum value in the transaction that added it fails in Postgres.
      "packages/db/prisma/migrations/2_add_value/migration.sql": `ALTER TYPE "Kind" ADD VALUE 'b';`,
      "packages/db/prisma/migrations/3_use_value/migration.sql": `INSERT INTO "Thing" VALUES ('t1', 'b');`,
    });
    const source = await findSchemaSource(dir);
    expect(source).toMatchObject({ kind: "migrations", tool: "prisma", dir: path.join(dir, "packages/db/prisma/migrations") });
    const file = await materializeSource(`spec-${path.basename(dir)}`, dir, source);
    try {
      const snap = await snapshotOf((await import("node:fs")).readFileSync(file, "utf8"));
      expect(snap.tables.map((t) => [t.name, t.rowCount])).toEqual([["Thing", 1]]);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("gives Supabase SQL its platform stand-ins", async () => {
    const snap = await snapshotOf(`
      CREATE TABLE profiles (id uuid PRIMARY KEY REFERENCES auth.users, token text DEFAULT encode(gen_random_bytes(8), 'hex'));
      ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own ON profiles TO authenticated USING (auth.uid() = id);`);
    expect(snap.tables.map((t) => t.name)).toEqual(["profiles"]);
  });

  it("loads pgvector tables", async () => {
    const snap = await snapshotOf(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE docs (id int PRIMARY KEY, title text);
      CREATE TABLE embeddings (id int PRIMARY KEY, doc_id int REFERENCES docs(id), v vector(3));
      CREATE INDEX ON embeddings USING hnsw (v vector_cosine_ops);`);
    expect(snap.tables.map((t) => t.name)).toEqual(["docs", "embeddings"]);
  });

  it("skips what needs a missing extension and reports it", async () => {
    const pg = await loadSql(`
      CREATE EXTENSION IF NOT EXISTS pg_search;
      CREATE TABLE docs (id int PRIMARY KEY, title text);
      CREATE TABLE notes (id int PRIMARY KEY, doc_id int REFERENCES docs(id), body text);
      CREATE INDEX notes_search ON notes USING bm25 (id, body) WITH (key_field = 'id');`);
    try {
      const snap = await introspect(pg);
      expect(snap.tables.map((t) => t.name)).toEqual(["docs", "notes"]);
      expect(loadReport(pg)).toEqual({ missing: ["pg_search"], skipped: 2, skippedTables: [] });
    } finally {
      await pg.close();
    }
  });

  it("maps app schemas besides public as schema.table", async () => {
    const snap = await snapshotOf(`
      CREATE SCHEMA basejump;
      CREATE TABLE basejump.accounts (id uuid PRIMARY KEY, name text);
      CREATE TABLE basejump.account_user (account_id uuid REFERENCES basejump.accounts(id), user_id uuid REFERENCES auth.users);
      CREATE TABLE notes (id int PRIMARY KEY, account_id uuid REFERENCES basejump.accounts(id));`);
    expect(snap.tables.map((t) => t.name)).toEqual(["notes", "basejump.account_user", "basejump.accounts"]);
    const notes = snap.tables.find((t) => t.name === "notes")!;
    expect(notes.foreignKeys[0]?.refTable).toBe("basejump.accounts");
    expect(snap.tables.find((t) => t.name === "basejump.account_user")!.foreignKeys).toHaveLength(1);
  });
});
