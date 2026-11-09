import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { fail, noteExternalWrite } from "@agent-native/core/action";

import { dataPath } from "./data-dir.js";

const exec = promisify(execFile);

export const DEMO_REPO_PATH = path.resolve(process.cwd(), "demo-repo");
const REPOS_DIR = dataPath("repos");

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
