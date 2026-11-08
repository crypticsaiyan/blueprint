import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { noteExternalWrite } from "@agent-native/core/action";

import type { TestCase } from "../db/schema.js";
import { RULES_SCRIPT } from "./ship.js";

const exec = promisify(execFile);
const BLUEPRINT_BIN = path.resolve(process.cwd(), "node_modules/.bin");

export interface TestRunResult {
  status: "passed" | "failed" | "error";
  command: string;
  cases: TestCase[];
  output: string;
  durationMs: number;
}

async function exists(file: string) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** A repo's own binary, or Blueprint's copy when the repo has no install (the bundled demo). */
async function binary(dir: string, name: string): Promise<string | null> {
  const own = path.join(dir, "node_modules/.bin", name);
  if (await exists(own)) return own;
  const shared = path.join(BLUEPRINT_BIN, name);
  return (await exists(shared)) ? shared : null;
}

async function run(cmd: string, args: string[], cwd: string, timeout = 300_000) {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NODE_ENV: "test" },
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string; message: string; killed?: boolean };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}${e.killed ? "\n[timed out]" : ""}` || e.message,
    };
  }
}

const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
/** Keeps the error, drops stack frames and absolute paths. */
const failureText = (text: string, dir: string) =>
  strip(text)
    .split("\n")
    .filter((line) => !/^\s+at /.test(line))
    .join("\n")
    .split(`${dir}/`)
    .join("")
    .trim();

async function installIfNeeded(dir: string, log: string[]) {
  if (await exists(path.join(dir, "node_modules"))) return;
  const lock = [
    ["pnpm-lock.yaml", "pnpm", ["install", "--frozen-lockfile"]],
    ["package-lock.json", "npm", ["ci"]],
    ["yarn.lock", "yarn", ["install", "--frozen-lockfile"]],
  ] as const;
  for (const [file, cmd, args] of lock) {
    if (await exists(path.join(dir, file))) {
      noteExternalWrite("local-disk");
      const result = await run(cmd, [...args], dir, 600_000);
      log.push(`$ ${cmd} ${args.join(" ")}\n${strip(result.output).slice(-4000)}`);
      return;
    }
  }
}

async function vitest(dir: string, bin: string, log: string[]): Promise<TestCase[] | null> {
  const out = await mkdtemp(path.join(tmpdir(), "blueprint-vitest-"));
  const file = path.join(out, "results.json");
  try {
    const result = await run(bin, ["--run", "--reporter=json", `--outputFile=${file}`, "--reporter=default"], dir);
    log.push(`$ vitest --run\n${strip(result.output).slice(-12000)}`);
    if (!(await exists(file))) return null;
    const json = JSON.parse(await readFile(file, "utf8")) as {
      testResults: {
        name: string;
        message?: string;
        status?: string;
        assertionResults: { fullName: string; status: string; failureMessages: string[] }[];
      }[];
    };
    const cases: TestCase[] = [];
    for (const suite of json.testResults) {
      const rel = path.relative(dir, suite.name);
      if (!suite.assertionResults.length && suite.status === "failed") {
        cases.push({ name: "(suite failed to load)", file: rel, status: "failed", message: strip(suite.message ?? "").slice(0, 1200) });
      }
      for (const test of suite.assertionResults) {
        cases.push({
          name: test.fullName,
          file: rel,
          status: test.status === "passed" ? "passed" : test.status === "failed" ? "failed" : "skipped",
          message: test.failureMessages.length ? failureText(test.failureMessages.join("\n"), dir).slice(0, 1200) : undefined,
        });
      }
    }
    return cases;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/**
 * Runs the repo's checks in the working copy: the test suite (structured
 * results for Vitest and Jest), the TypeScript typecheck, and dependency rules.
 */
export async function runRepoTests(dir: string): Promise<TestRunResult> {
  const started = Date.now();
  const log: string[] = [];
  const cases: TestCase[] = [];
  const commands: string[] = [];
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return { status: "error", command: "", cases: [], output: "No package.json; Blueprint runs tests for Node projects only.", durationMs: 0 };
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  await installIfNeeded(dir, log);
  noteExternalWrite("local-disk");

  const vitestBin = deps.vitest ? await binary(dir, "vitest") : null;
  if (vitestBin) {
    commands.push("vitest --run");
    const found = await vitest(dir, vitestBin, log);
    if (found) cases.push(...found);
    else cases.push({ name: "test suite", file: "", status: "failed", message: "Vitest produced no results; see output." });
  } else if (pkg.scripts?.test) {
    commands.push("npm test");
    const result = await run("npm", ["test", "--silent"], dir);
    log.push(`$ npm test\n${strip(result.output).slice(-12000)}`);
    cases.push({ name: "npm test", file: "", status: result.code === 0 ? "passed" : "failed", message: result.code ? strip(result.output).slice(-1200) : undefined });
  }

  if (deps.typescript && (await exists(path.join(dir, "tsconfig.json")))) {
    const tsc = await binary(dir, "tsc");
    if (tsc) {
      commands.push("tsc --noEmit");
      const result = await run(tsc, ["--noEmit", "-p", "."], dir);
      const errors = strip(result.output).split("\n").filter((l) => /error TS\d+/.test(l));
      log.push(`$ tsc --noEmit\n${strip(result.output).slice(-6000)}`);
      cases.push({
        name: "typecheck",
        file: "tsconfig.json",
        status: result.code === 0 ? "passed" : "failed",
        message: result.code ? errors.slice(0, 12).join("\n") || strip(result.output).slice(-1200) : undefined,
      });
    }
  }

  if (await exists(path.join(dir, RULES_SCRIPT))) {
    commands.push(`node ${RULES_SCRIPT}`);
    const result = await run(process.execPath, [RULES_SCRIPT], dir);
    log.push(`$ node ${RULES_SCRIPT}\n${strip(result.output)}`);
    cases.push({
      name: "dependency rules",
      file: RULES_SCRIPT,
      status: result.code === 0 ? "passed" : "failed",
      message: result.code ? strip(result.output).slice(0, 1200) : undefined,
    });
  }

  if (!cases.length) {
    return { status: "error", command: "", cases, output: "No test runner found (no vitest and no test script).", durationMs: Date.now() - started };
  }
  return {
    status: cases.some((c) => c.status === "failed") ? "failed" : "passed",
    command: commands.join(" && "),
    cases,
    output: log.join("\n\n").slice(-60000),
    durationMs: Date.now() - started,
  };
}
