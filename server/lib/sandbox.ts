import { readFile } from "node:fs/promises";

import { PGlite, type PGliteInterface } from "@electric-sql/pglite";

// One in-memory Postgres per project holds the imported sample data. It is
// never written to: previews read it, rehearsals run on clones of it.
const sources = new Map<string, Promise<PGlite>>();

async function load(dumpPath: string): Promise<PGlite> {
  const dump = await readFile(dumpPath, "utf8");
  const pg = new PGlite();
  try {
    await pg.exec(dump);
  } catch (error) {
    await pg.close();
    throw error;
  }
  return pg;
}

export function sourceDb(projectId: string, dumpPath: string): Promise<PGlite> {
  let pending = sources.get(projectId);
  if (!pending) {
    pending = load(dumpPath);
    sources.set(projectId, pending);
    pending.catch(() => sources.delete(projectId));
  }
  return pending;
}

/** Loads a dump into a throwaway database, for validating an import. */
export async function loadDump(dumpPath: string): Promise<PGlite> {
  return load(dumpPath);
}

export async function cloneSource(
  projectId: string,
  dumpPath: string,
): Promise<PGliteInterface> {
  const source = await sourceDb(projectId, dumpPath);
  return source.clone();
}

export function dropSource(projectId: string) {
  const pending = sources.get(projectId);
  sources.delete(projectId);
  void pending?.then((pg) => pg.close()).catch(() => {});
}
