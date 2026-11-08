import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fail, noteExternalWrite } from "@agent-native/core/action";
import { resolveSecretDetailed } from "@agent-native/core/server";
import { Octokit } from "octokit";

import { git } from "./workspace.js";

export function parseRepo(value: string) {
  const match = value
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) fail('Use a GitHub repo like "owner/name".', { errorCode: "invalid_repo" });
  return { owner: match[1]!, repo: match[2]! };
}

export async function githubToken(): Promise<string> {
  const secret = await resolveSecretDetailed("GITHUB_TOKEN");
  if (secret.lookupFailed) {
    fail("Could not read the GitHub token right now. Try again.", { errorCode: "secret_lookup_failed", statusCode: 503 });
  }
  if (!secret.value) {
    fail("Add a GitHub token (GITHUB_TOKEN) in Settings → Secrets so Blueprint can open the pull request.", {
      errorCode: "github_token_missing",
      statusCode: 412,
    });
  }
  return secret.value;
}

/** The token travels in a header for each git call; it never lands in a URL or git config. */
function authArgs(token: string) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

export async function openPullRequest(options: {
  token: string;
  owner: string;
  repo: string;
  patch: string;
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
}) {
  const octokit = new Octokit({ auth: options.token });
  let base: string;
  try {
    base = (await octokit.rest.repos.get({ owner: options.owner, repo: options.repo })).data.default_branch;
  } catch (error) {
    fail(`GitHub could not find ${options.owner}/${options.repo} with this token (${(error as { status?: number }).status ?? "error"}).`, {
      errorCode: "repo_not_found",
      statusCode: 502,
    });
  }
  const dir = await mkdtemp(path.join(tmpdir(), "blueprint-pr-"));
  noteExternalWrite("github");
  try {
    const url = `https://github.com/${options.owner}/${options.repo}.git`;
    await git(tmpdir(), [...authArgs(options.token), "clone", "-q", "--depth", "1", "--branch", base, url, dir]);
    await git(dir, ["checkout", "-q", "-b", options.branch]);
    try {
      await git(dir, ["apply", "--index", "--whitespace=nowarn", "-"], options.patch);
    } catch (error) {
      fail(
        `The changes do not apply cleanly to ${options.owner}/${options.repo}@${base}; the repo has moved on since import. ${(error as { stderr?: string }).stderr?.split("\n")[0] ?? ""}`,
        { errorCode: "patch_conflict", statusCode: 409 },
      );
    }
    const name = (await git(dir, ["config", "user.name"]).catch(() => "")).trim();
    const identity = name ? [] : ["-c", "user.name=Blueprint", "-c", "user.email=blueprint@localhost"];
    await git(dir, [...identity, "commit", "-q", "--no-verify", "-m", options.commitMessage]);
    await git(dir, [...authArgs(options.token), "push", "-q", "origin", options.branch]);
    const pr = await octokit.rest.pulls.create({
      owner: options.owner,
      repo: options.repo,
      head: options.branch,
      base,
      title: options.title,
      body: options.body,
    });
    return { url: pr.data.html_url, number: pr.data.number, base };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
