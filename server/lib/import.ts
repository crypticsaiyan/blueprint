import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { fail, noteExternalWrite } from "@agent-native/core/action";

const exec = promisify(execFile);

export const DEMO_REPO_PATH = path.resolve(process.cwd(), "demo-repo");
const REPOS_DIR = path.resolve(process.cwd(), "data/repos");

const DUMP_CANDIDATES = [
  "db/dump.sql",
  "dump.sql",
  "db/seed.sql",
  "seed.sql",
  "database/dump.sql",
  "sql/dump.sql",
  "db/schema.sql",
  "schema.sql",
];

export function parseGithubUrl(url: string) {
  const match = url
    .trim()
    .match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) {
    fail("Use a GitHub URL like https://github.com/owner/repo.", {
      errorCode: "invalid_repo_url",
    });
  }
  const [, owner = "", repo = ""] = match;
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

export async function cloneRepo(url: string, projectId: string): Promise<string> {
  const dest = path.join(REPOS_DIR, projectId);
  await mkdir(REPOS_DIR, { recursive: true });
  noteExternalWrite("local-disk");
  try {
    await exec("git", ["clone", "--depth", "1", url, dest], {
      timeout: 90_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    await removeCheckout(dest);
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const reason =
      stderr.match(/fatal: (.*)/)?.[1] ?? "the repository is private, missing, or unreachable";
    fail(`Could not clone ${url}: ${reason}`, { errorCode: "clone_failed", statusCode: 502 });
  }
  return dest;
}

/** Removes a checkout this import created, after the import failed. */
export async function removeCheckout(dest: string) {
  if (!dest.startsWith(REPOS_DIR + path.sep)) return;
  await rm(dest, { recursive: true, force: true });
}

async function looksLikeDump(file: string) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 50 * 1024 * 1024) return false;
    const head = (await readFile(file, "utf8")).slice(0, 200_000);
    return /create\s+table/i.test(head);
  } catch {
    return false;
  }
}

async function walkSql(dir: string, depth: number, out: string[]) {
  if (depth < 0) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkSql(full, depth - 1, out);
    else if (entry.name.endsWith(".sql")) out.push(full);
  }
}

/** Finds the SQL dump in a checkout: an explicit path, a known name, or any .sql with tables. */
export async function findDump(repoPath: string, explicit?: string): Promise<string> {
  if (explicit) {
    const full = path.resolve(repoPath, explicit);
    if (!full.startsWith(repoPath + path.sep) || !(await looksLikeDump(full))) {
      fail(`No SQL dump with CREATE TABLE statements at ${explicit}.`, {
        errorCode: "dump_not_found",
      });
    }
    return full;
  }
  for (const candidate of DUMP_CANDIDATES) {
    const full = path.join(repoPath, candidate);
    if (await looksLikeDump(full)) return full;
  }
  const found: string[] = [];
  await walkSql(repoPath, 3, found);
  for (const file of found.sort()) {
    if (await looksLikeDump(file)) return file;
  }
  fail(
    "No sample data found. Add a plain SQL dump (pg_dump --inserts) such as db/dump.sql to the repo, or pass dumpPath.",
    { errorCode: "dump_not_found" },
  );
}
