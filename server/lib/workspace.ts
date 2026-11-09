import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { fail, noteExternalWrite } from "@agent-native/core/action";

import { dataPath } from "./data-dir.js";
import type { ChangesetRow, ProjectRow } from "./projects.js";

const exec = promisify(execFile);
const WORKSPACES = dataPath("workspaces");
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

/** Removes a changeset's working copy, installed dependencies included. */
export async function removeWorkspace(changesetId: string) {
  const dir = workspacePath(changesetId);
  if (path.dirname(dir) !== WORKSPACES) return;
  noteExternalWrite("local-disk");
  await rm(dir, { recursive: true, force: true });
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
const EXCLUDE = "node_modules/\n.vite/\ndist/\ncoverage/\n*.log\n*.tsbuildinfo\n.turbo/\n.DS_Store\n";

export async function ensureWorkspace(project: ProjectRow, changeset: ChangesetRow): Promise<string> {
  const dir = workspacePath(changeset.id);
  if (await exists(path.join(dir, ".git"))) {
    // Test runs leave caches behind; keep them out of the diff.
    await writeFile(path.join(dir, ".git/info/exclude"), EXCLUDE);
    return dir;
  }
  await mkdir(WORKSPACES, { recursive: true });
  noteExternalWrite("local-disk");
  await cp(project.repoPath, dir, {
    recursive: true,
    filter: (source) => !COPY_SKIP.test(path.relative(project.repoPath, source)),
  });
  await git(dir, ["init", "-q", "-b", "main"]);
  await mkdir(path.join(dir, ".git/info"), { recursive: true });
  await writeFile(path.join(dir, ".git/info/exclude"), EXCLUDE);
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

export async function readWorkspaceBytes(dir: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFile(resolveInside(dir, rel));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeWorkspaceFile(dir: string, rel: string, content: string | Buffer) {
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

/** The baseline's bytes, for files that are not UTF-8 (Supabase types can be UTF-16). */
export async function baselineBytes(dir: string, rel: string): Promise<Buffer | null> {
  try {
    const { stdout } = await exec("git", ["show", `${BASELINE}:${rel}`], { cwd: dir, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

export interface WorkspaceDiff {
  files: { path: string; status: string; additions: number; deletions: number }[];
  patch: string;
}

/**
 * The staged diff against the baseline. `forReview` renders UTF-16 text files
 * as text; the default keeps them binary so the patch applies byte for byte.
 */
export async function workspaceDiff(dir: string, forReview = false): Promise<WorkspaceDiff> {
  await writeFile(path.join(dir, ".git/info/exclude"), EXCLUDE);
  // Drop anything an older run staged before it was excluded.
  await git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "node_modules", ".vite", "dist", "coverage"]);
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
  if (!forReview) return { files, patch: await git(dir, ["diff", "--cached", "--binary", "--no-textconv", BASELINE]) };
  const utf16: string[] = [];
  for (const file of files) {
    const head = await readWorkspaceBytes(dir, file.path).catch(() => null);
    if (head && head[0] === 0xff && head[1] === 0xfe) utf16.push(file.path);
  }
  await writeFile(path.join(dir, ".git/info/attributes"), utf16.map((f) => `/${f.replace(/ /g, "[ ]")} diff=utf16\n`).join(""));
  const textconv = ["-c", `diff.utf16.textconv=${process.execPath} -e "process.stdout.write(require('fs').readFileSync(process.argv[1]).subarray(2).toString('utf16le').replace(/\\r\\n/g,'\\n'))"`];
  const patch = await git(dir, [...textconv, "diff", "--cached", BASELINE]);
  if (utf16.length) {
    // numstat counted those files as binary; count their text lines instead.
    const counted = await git(dir, [...textconv, "diff", "--cached", "--numstat", BASELINE, "--", ...utf16]);
    for (const line of counted.trim().split("\n").filter(Boolean)) {
      const [add, del, name] = line.split("\t");
      const file = files.find((f) => f.path === name);
      if (file && add !== "-") Object.assign(file, { additions: Number(add), deletions: Number(del) });
    }
  }
  return { files, patch };
}
