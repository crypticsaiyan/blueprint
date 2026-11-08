import { execFile } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { fail, noteExternalWrite } from "@agent-native/core/action";

import type { ChangesetRow, ProjectRow } from "./projects.js";

const exec = promisify(execFile);
const WORKSPACES = path.resolve(process.cwd(), "data/workspaces");
export const BASELINE = "blueprint-baseline";
const COPY_SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage|data)(\/|$)/;

export async function git(cwd: string, args: string[], input?: string) {
  const child = exec("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (input !== undefined) {
    child.child.stdin?.end(input);
  }
  const { stdout } = await child;
  return stdout;
}

export function workspacePath(changesetId: string) {
  return path.join(WORKSPACES, changesetId);
}

async function exists(file: string) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function hasWorkspace(changesetId: string) {
  return exists(path.join(workspacePath(changesetId), ".git"));
}

/**
 * A changeset's working copy of the repo. Generated files and agent edits
 * land here; tests run here; the PR is the diff against the baseline tag.
 */
export async function ensureWorkspace(project: ProjectRow, changeset: ChangesetRow): Promise<string> {
  const dir = workspacePath(changeset.id);
  if (await exists(path.join(dir, ".git"))) return dir;
  await mkdir(WORKSPACES, { recursive: true });
  noteExternalWrite("local-disk");
  await cp(project.repoPath, dir, {
    recursive: true,
    filter: (source) => !COPY_SKIP.test(path.relative(project.repoPath, source)),
  });
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=Blueprint", "-c", "user.email=blueprint@localhost", "commit", "-q", "-m", "Baseline", "--no-verify"]);
  await git(dir, ["tag", BASELINE]);
  return dir;
}

/** Resolves a repo-relative path inside the workspace, refusing escapes. */
export function resolveInside(dir: string, rel: string): string {
  const full = path.resolve(dir, rel);
  if (!full.startsWith(dir + path.sep) || full.includes(`${path.sep}.git${path.sep}`)) {
    fail(`Path ${rel} is outside the repository.`, { errorCode: "invalid_path" });
  }
  return full;
}

export async function readWorkspaceFile(dir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(resolveInside(dir, rel), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeWorkspaceFile(dir: string, rel: string, content: string) {
  const full = resolveInside(dir, rel);
  noteExternalWrite("local-disk");
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

export async function baselineFile(dir: string, rel: string): Promise<string | null> {
  try {
    return await git(dir, ["show", `${BASELINE}:${rel}`]);
  } catch {
    return null;
  }
}

export interface WorkspaceDiff {
  files: { path: string; status: string; additions: number; deletions: number }[];
  patch: string;
}

export async function workspaceDiff(dir: string): Promise<WorkspaceDiff> {
  await git(dir, ["add", "-A"]);
  const numstat = await git(dir, ["diff", "--cached", "--numstat", BASELINE]);
  const names = await git(dir, ["diff", "--cached", "--name-status", BASELINE]);
  const status = new Map(
    names
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [code, ...rest] = line.split("\t");
        return [rest[rest.length - 1]!, code!] as const;
      }),
  );
  const files = numstat
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [add, del, file] = line.split("\t");
      return {
        path: file!,
        status: status.get(file!) ?? "M",
        additions: add === "-" ? 0 : Number(add),
        deletions: del === "-" ? 0 : Number(del),
      };
    });
  const patch = await git(dir, ["diff", "--cached", "--binary", BASELINE]);
  return { files, patch };
}
