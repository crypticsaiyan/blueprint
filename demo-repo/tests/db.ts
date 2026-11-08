import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import type { Db } from "../src/db/client";
import * as schema from "../src/db/schema";

const dumpPath = join(import.meta.dirname, "../db/dump.sql");

export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  await client.exec(readFileSync(dumpPath, "utf8"));
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, close: () => client.close() };
}
