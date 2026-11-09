import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { noteExternalWrite } from "@agent-native/core/action";

import type { TestCase } from "../db/schema.js";
import { dataPath } from "./data-dir.js";
import { RULES_SCRIPT } from "./ship.js";
import { currentSignal, progress, TestsCancelledError, throwIfCancelled } from "./test-jobs.js";
import { BASELINE, git } from "./workspace.js";

const BLUEPRINT_BIN = path.resolve(process.cwd(), "node_modules/.bin");

export interface TestRunResult {
  /** "none" when the repo has no checks Blueprint can run. */
  status: "passed" | "failed" | "error" | "none";
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

/**
 * A repo's own binary (in its root or a workspace package), or Blueprint's
 * copy when the repo has nothing to install (the bundled demo). After an
 * install was attempted, Blueprint's copy is never a stand-in: a different
 * compiler or test runner version gives answers about the wrong setup.
 */
async function binary(dir: string, name: string, allowShared: boolean, packageDirs: string[] = []): Promise<string | null> {
  for (const base of [dir, ...packageDirs]) {
    const own = path.join(base, "node_modules/.bin", name);
    if (await exists(own)) return own;
  }
  if (!allowShared) return null;
  const shared = path.join(BLUEPRINT_BIN, name);
  return (await exists(shared)) ? shared : null;
}

const MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * Runs a command in its own process group, so a timeout or a cancel stops
 * everything it started (pnpm, vitest workers, tsc), not just the parent.
 */
async function run(cmd: string, args: string[], cwd: string, timeout = 300_000): Promise<{ code: number; output: string }> {
  throwIfCancelled();
  const signal = currentSignal();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NODE_ENV: "test" },
    });
    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let stoppedFor: "timeout" | "cancel" | null = null;
    const stop = (why: "timeout" | "cancel") => {
      stoppedFor = why;
      const group = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          // Already gone.
        }
      };
      group("SIGTERM");
      setTimeout(() => group("SIGKILL"), 3000).unref();
    };
    const timer = setTimeout(() => stop("timeout"), timeout);
    const onAbort = () => stop("cancel");
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      done();
      resolve({ code: 1, output: output || error.message });
    });
    child.on("close", (code) => {
      done();
      if (stoppedFor === "cancel") reject(new TestsCancelledError());
      else resolve({ code: code ?? 1, output: `${output}${stoppedFor === "timeout" ? "\n[timed out]" : ""}` });
    });
  });
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

// Vitest's JSON reporter keeps only the top error's stack. ORMs wrap database
// errors ("Failed query: ..."), so the Postgres reason sits in `error.cause`.
// This reporter records cause chains; it supports Vitest 3+ and 1-2 hooks.
const causesReporter = (outFile: string) => `import { writeFileSync } from "node:fs";
const causes = {};
function chain(error) {
  const lines = [];
  for (let c = error && error.cause, depth = 0; c && depth < 5; c = c.cause, depth += 1) {
    const message = typeof c === "object" ? c.message || String(c) : String(c);
    const label = (c.name && !/^(Caused by: )?Error$/.test(c.name) ? c.name + ": " : "") + message;
    lines.push("Caused by: " + label.replace(/^(Caused by:\\s*)+/, "").replace(/^Error:\\s*/, ""));
    for (const key of ["detail", "hint", "code"]) if (c[key]) lines.push("  " + key + ": " + c[key]);
  }
  return lines.join("\\n");
}
function record(file, titles, errors) {
  const text = (errors || []).map(chain).filter(Boolean).join("\\n");
  if (text) causes[file + "\\u0000" + titles.join(" ")] = text;
}
function walk(file, tasks, titles) {
  for (const task of tasks || []) {
    const next = [...titles, task.name];
    if (task.type === "suite") walk(file, task.tasks, next);
    else if (task.result && task.result.state === "fail") record(file, next, task.result.errors);
  }
}
export default class BlueprintCauses {
  onTestRunEnd(modules) {
    for (const mod of modules) {
      for (const test of mod.children.allTests()) {
        const result = test.result();
        if (result.state !== "failed") continue;
        const titles = [test.name];
        for (let p = test.parent; p && p.type === "suite"; p = p.parent) titles.unshift(p.name);
        record(mod.moduleId, titles, result.errors);
      }
    }
    this.flush();
  }
  onFinished(files) {
    if (this.done) return;
    for (const file of files || []) walk(file.filepath, file.tasks, []);
    this.flush();
  }
  flush() {
    this.done = true;
    writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(causes));
  }
}
`;

export interface InstallResult {
  /** A lockfile was found, so the repo expects its own dependencies. */
  attempted: boolean;
  ok: boolean;
  output: string;
}

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"];

/** Installs the repo's dependencies in its working copy, once. */
export async function prepareDependencies(dir: string): Promise<InstallResult & { log: string[] }> {
  const log: string[] = [];
  return { ...(await installIfNeeded(dir, log)), log };
}

async function installIfNeeded(dir: string, log: string[]): Promise<InstallResult> {
  const locked = (await Promise.all(LOCKFILES.map((f) => exists(path.join(dir, f))))).some(Boolean);
  // No lockfile: nothing to install (the bundled demo runs on Blueprint's tools).
  if (!locked) return { attempted: false, ok: true, output: "" };
  // A folder of links is an install; a bare node_modules can be a tool cache.
  if (await exists(path.join(dir, "node_modules/.bin"))) return { attempted: true, ok: true, output: "" };
  let pkg: { packageManager?: string } = {};
  try {
    pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    // Checked by the caller.
  }
  const pinned = pkg.packageManager?.match(/^(pnpm|yarn|npm)@([\w.-]+)/);
  const versions: Record<string, string> = pinned ? { [pinned[1]!]: pinned[2]!.split("+")[0]! } : {};
  // Unpinned pnpm: the lockfile format says which major wrote it, and newer
  // majors refuse older formats under --frozen-lockfile.
  if (!versions.pnpm && (await exists(path.join(dir, "pnpm-lock.yaml")))) {
    const format = (await readFile(path.join(dir, "pnpm-lock.yaml"), "utf8")).match(/lockfileVersion:\s*'?([\d.]+)/)?.[1];
    const major = format ? Number.parseFloat(format) : NaN;
    if (major >= 5 && major < 6) versions.pnpm = "7";
    else if (major >= 6 && major < 7) versions.pnpm = "8";
  }
  const via = (tool: string, args: string[]): [string, string[]] =>
    versions[tool] ? ["npx", ["--yes", `${tool}@${versions[tool]}`, ...args]] : [tool, args];
  // Without its own pnpm-workspace.yaml, pnpm would climb to a parent
  // workspace (Blueprint's own checkout) and install there.
  const ownWorkspace = await exists(path.join(dir, "pnpm-workspace.yaml"));
  const plans: [string, [string, string[]]][] = [
    // Engine checks are off: tests run on the Node this machine has, which
    // often differs from the exact major a repo pins.
    [
      "pnpm-lock.yaml",
      via("pnpm", ["install", "--frozen-lockfile", "--config.engine-strict=false", ...(ownWorkspace ? [] : ["--ignore-workspace"])]),
    ],
    ["package-lock.json", via("npm", ["ci", "--no-audit", "--no-fund", "--engine-strict=false"])],
    ["yarn.lock", via("yarn", ["install", "--frozen-lockfile"])],
    ["bun.lock", ["bun", ["install", "--frozen-lockfile"]]],
    ["bun.lockb", ["bun", ["install", "--frozen-lockfile"]]],
  ];
  for (const [file, [cmd, args]] of plans) {
    if (!(await exists(path.join(dir, file)))) continue;
    noteExternalWrite("local-disk");
    const tool = cmd === "npx" ? args[1]!.split("@")[0]! : cmd;
    progress(`Installing dependencies with ${tool}`);
    let result = await installWith(cmd, args, dir, log);
    if (result.code !== 0 && !/ERR_PNPM_(OUTDATED|NO)_LOCKFILE|lockfile.*(out of date|not up to date)/i.test(result.output)) {
      // A dependency's install script (a CLI downloading its binary, say) is
      // often what fails; the code and its tests rarely need it.
      progress(`Installing dependencies with ${tool}, without install scripts`);
      result = await installWith(cmd, [...args, "--ignore-scripts"], dir, log);
    }
    if (result.code === 0) await generatePrismaClients(dir, log);
    return { attempted: true, ok: result.code === 0, output: result.output };
  }
  return { attempted: false, ok: true, output: "" };
}

async function installWith(cmd: string, args: string[], dir: string, log: string[]) {
  const result = await run(cmd, args, dir, 900_000);
  // npx and npm print config warnings that bury the real error.
  const output = strip(result.output)
    .split("\n")
    .filter((line) => !/^npm (warn|notice)\b/.test(line))
    .join("\n")
    .slice(-4000);
  log.push(`$ ${cmd} ${args.join(" ")}\n${output}`);
  return { code: result.code, output };
}

/**
 * Prisma code imports a client generated from schema.prisma, which installs
 * only make when a postinstall script says so. Each package with Prisma gets
 * `prisma generate`, so tests and the typecheck see the client.
 */
async function generatePrismaClients(dir: string, log: string[]) {
  for (const base of [dir, ...(await workspacePackages(dir))]) {
    let deps: Record<string, string> = {};
    try {
      const p = JSON.parse(await readFile(path.join(base, "package.json"), "utf8"));
      deps = { ...p.dependencies, ...p.devDependencies };
    } catch {
      continue;
    }
    if (!deps.prisma && !deps["@prisma/client"]) continue;
    const configured = await Promise.all(
      ["prisma/schema.prisma", "schema.prisma", "prisma.config.ts", "prisma/schema"].map((f) => exists(path.join(base, f))),
    );
    if (!configured.some(Boolean)) continue;
    const bin = await binary(base, "prisma", false, [dir]);
    if (!bin) continue;
    progress(`Generating the Prisma client${path.relative(dir, base) ? ` (${path.relative(dir, base)})` : ""}`);
    const result = await run(bin, ["generate"], base, 300_000);
    log.push(`$ prisma generate (${path.relative(dir, base) || "."})\n${strip(result.output).slice(-2000)}`);
  }
}

/** Workspace package folders, where monorepos keep their test runners. */
async function workspacePackages(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const group of ["packages", "apps", "libs", "services"]) {
    try {
      for (const entry of await readdir(path.join(dir, group), { withFileTypes: true })) {
        if (entry.isDirectory() && (await exists(path.join(dir, group, entry.name, "package.json")))) {
          out.push(path.join(dir, group, entry.name));
        }
      }
    } catch {
      // No such folder.
    }
  }
  return out;
}

async function vitest(dir: string, bin: string, log: string[], root = dir): Promise<TestCase[] | null> {
  const out = await mkdtemp(path.join(tmpdir(), "blueprint-vitest-"));
  const file = path.join(out, "results.json");
  const causesFile = path.join(out, "causes.json");
  const reporter = path.join(out, "causes-reporter.mjs");
  try {
    await writeFile(reporter, causesReporter(causesFile));
    const result = await run(
      bin,
      ["--run", "--reporter=json", `--outputFile=${file}`, "--reporter=default", `--reporter=${reporter}`],
      dir,
    );
    log.push(`$ vitest --run\n${strip(result.output).slice(-12000)}`);
    if (!(await exists(file))) return null;
    const json = JSON.parse(await readFile(file, "utf8")) as {
      testResults: {
        name: string;
        message?: string;
        status?: string;
        assertionResults: { fullName: string; ancestorTitles?: string[]; title?: string; status: string; failureMessages: string[] }[];
      }[];
    };
    let causes: Record<string, string> = {};
    try {
      causes = JSON.parse(await readFile(causesFile, "utf8"));
    } catch {
      // Older or unusual Vitest setups: fall back to the JSON messages alone.
    }
    const cases: TestCase[] = [];
    for (const suite of json.testResults) {
      const rel = path.relative(root, suite.name);
      if (!suite.assertionResults.length && suite.status === "failed") {
        cases.push({ name: "(suite failed to load)", file: rel, status: "failed", message: strip(suite.message ?? "").slice(0, 1200) });
      }
      for (const test of suite.assertionResults) {
        const titles = test.title !== undefined ? [...(test.ancestorTitles ?? []), test.title] : [test.fullName];
        const cause = causes[`${suite.name}\u0000${titles.join(" ")}`];
        const message = [failureText(test.failureMessages.join("\n"), root), cause ?? ""].filter(Boolean).join("\n");
        cases.push({
          name: test.fullName,
          file: rel,
          status: test.status === "passed" ? "passed" : test.status === "failed" ? "failed" : "skipped",
          message: test.failureMessages.length ? message.slice(0, 1600) : undefined,
        });
      }
    }
    return cases;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

interface Suites {
  dir: string;
  deps: Record<string, string>;
  scripts: Record<string, string> | undefined;
  packages: string[];
  allowShared: boolean;
}

/** Vitest (or npm test) and tsc, as the repo sets them up. */
async function runSuites({ dir, deps, scripts, packages, allowShared }: Suites, log: string[], commands: string[]): Promise<TestCase[]> {
  const cases: TestCase[] = [];
  const pkgOf = async (base: string) => {
    try {
      const p = JSON.parse(await readFile(path.join(base, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return { ...p.dependencies, ...p.devDependencies };
    } catch {
      return {} as Record<string, string>;
    }
  };
  // A root Vitest config can list the packages as projects, so it runs from
  // the root. Without one, each package with its own config or Vitest runs
  // alone (Vitest 4 ignores vitest.workspace files, so a root run would use
  // no package's config).
  const hasConfig = async (base: string) =>
    (await readdir(base).catch(() => [] as string[])).some((f) => /^vitest\.config\.(ts|mts|cts|js|mjs|cjs)$/.test(f));
  const vitestRoots: string[] = [];
  if (await hasConfig(dir)) vitestRoots.push(dir);
  else {
    for (const base of packages) if ((await hasConfig(base)) || (await pkgOf(base)).vitest) vitestRoots.push(base);
    if (!vitestRoots.length && deps.vitest) vitestRoots.push(dir);
  }
  for (const base of vitestRoots) {
    const bin = await binary(base, "vitest", allowShared, base === dir ? [] : [dir]);
    const label = base === dir ? "vitest --run" : `vitest --run (${path.relative(dir, base)})`;
    if (!bin) continue;
    commands.push(label);
    progress(`Running ${label}`);
    const found = await vitest(base, bin, log, dir);
    if (found) cases.push(...found);
    else cases.push({ name: "test suite", file: path.relative(dir, base), status: "failed", message: "Vitest produced no results; see output." });
  }
  if (!vitestRoots.length && scripts?.test) {
    commands.push("npm test");
    progress("Running npm test");
    const result = await run("npm", ["test", "--silent"], dir);
    log.push(`$ npm test\n${strip(result.output).slice(-12000)}`);
    cases.push({ name: "npm test", file: "", status: result.code === 0 ? "passed" : "failed", message: result.code ? strip(result.output).slice(-1200) : undefined });
  }

  // The root tsconfig, or each package's when the root has none.
  const tsRoots = (await exists(path.join(dir, "tsconfig.json"))) && deps.typescript ? [dir] : [];
  if (!tsRoots.length) {
    for (const base of packages) if (await exists(path.join(base, "tsconfig.json"))) tsRoots.push(base);
  }
  for (const base of tsRoots) {
    const tsc = await binary(base, "tsc", allowShared, base === dir ? [] : [dir]);
    if (!tsc) continue;
    const rel = path.relative(dir, base);
    commands.push(rel ? `tsc --noEmit (${rel})` : "tsc --noEmit");
    progress(`Typechecking${rel ? ` ${rel}` : ""}`);
    const result = await run(tsc, ["--noEmit", "-p", "."], base);
    const errors = strip(result.output).split("\n").filter((l) => /error TS\d+/.test(l)).map((l) => (rel ? `${rel}/${l}` : l));
    log.push(`$ tsc --noEmit${rel ? ` (${rel})` : ""}\n${strip(result.output).slice(-6000)}`);
    cases.push({
      name: rel ? `typecheck ${rel}` : "typecheck",
      file: rel ? `${rel}/tsconfig.json` : "tsconfig.json",
      status: result.code === 0 ? "passed" : "failed",
      message: result.code ? errors.slice(0, 12).join("\n") || strip(result.output).slice(-1200) : undefined,
    });
  }
  return cases;
}

const BASELINES = dataPath("baselines");
const STASH = "blueprint-baseline-run";

/** A typecheck error without its line and column, which edits can shift. */
const errorKey = (line: string) => line.replace(/\(\d+,\d+\)/, "").trim();
const caseKey = (c: TestCase) => `${c.file}\u0000${c.name}`;

/** Puts the changeset's edits back if a baseline run was cut off. */
export async function restoreStashedChanges(dir: string) {
  const list = await git(dir, ["stash", "list"]).catch(() => "");
  if (list.includes(STASH)) await git(dir, ["stash", "pop", "-q"]).catch(() => {});
}

/**
 * Failing checks get compared with the same checks on the untouched code
 * (run once per repo snapshot, then cached). A test that already failed
 * there, or a typecheck with no new errors, is marked preexisting: real
 * repos often have tests that need services or secrets this machine lacks.
 */
async function markPreexisting(dir: string, cases: TestCase[], rerun: () => Promise<TestCase[]>): Promise<boolean> {
  let ran = false;
  let baseline: TestCase[] | null = null;
  const tree = (await git(dir, ["rev-parse", `${BASELINE}^{tree}`]).catch(() => "")).trim();
  const cacheFile = tree ? path.join(BASELINES, `${tree}.json`) : null;
  if (cacheFile) {
    try {
      baseline = JSON.parse(await readFile(cacheFile, "utf8")) as TestCase[];
    } catch {
      // Not cached yet.
    }
  }
  if (!baseline) {
    // Only safe when nothing is committed on top of the baseline yet.
    const head = (await git(dir, ["rev-parse", "HEAD"]).catch(() => "")).trim();
    const base = (await git(dir, ["rev-parse", `${BASELINE}^{commit}`]).catch(() => "")).trim();
    if (!head || head !== base) return false;
    await git(dir, ["stash", "push", "--include-untracked", "-q", "-m", STASH]);
    const saved = (await git(dir, ["stash", "list"])).includes(STASH);
    try {
      ran = true;
      progress("Running the failing checks on the untouched code, to tell new failures from old ones");
      baseline = await rerun();
    } finally {
      if (saved) await git(dir, ["stash", "pop", "-q"]);
    }
    if (cacheFile) {
      await mkdir(BASELINES, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(baseline));
    }
  }
  const before = new Map(baseline.map((c) => [caseKey(c), c]));
  for (const c of cases) {
    if (c.status !== "failed") continue;
    const old = before.get(caseKey(c));
    if (!old || old.status !== "failed") continue;
    if (!c.name.startsWith("typecheck")) {
      c.status = "preexisting";
      continue;
    }
    const known = new Set((old.message ?? "").split("\n").map(errorKey));
    const fresh = (c.message ?? "").split("\n").filter((l) => /error TS\d+/.test(l) && !known.has(errorKey(l)));
    if (!fresh.length) c.status = "preexisting";
    else c.message = `${fresh.slice(0, 12).join("\n")}\n(errors the code already had before the change are left out)`;
  }
  return ran;
}


/**
 * Runs the repo's checks in the working copy: the test suite (structured
 * results for Vitest and Jest), the TypeScript typecheck, and dependency rules.
 */
export async function runRepoTests(dir: string, prepared?: InstallResult & { log: string[] }): Promise<TestRunResult> {
  const started = Date.now();
  const log: string[] = [];
  const cases: TestCase[] = [];
  const commands: string[] = [];
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return { status: "none", command: "", cases: [], output: "No package.json, so there are no Node tests to run. The rehearsal is the only check.", durationMs: 0 };
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (prepared) log.push(...prepared.log);
  const install = prepared ?? (await installIfNeeded(dir, log));
  noteExternalWrite("local-disk");
  const allowShared = !install.attempted;
  const packages = await workspacePackages(dir);

  if (!install.ok) {
    cases.push({
      name: "install dependencies",
      file: "package.json",
      status: "failed",
      message: `The repo's dependencies did not install, so tests and the typecheck could not run.\n${install.output.slice(-1000)}`,
    });
  } else {
    const suites = { dir, deps, scripts: pkg.scripts, packages, allowShared };
    // The Prisma client must match the schema the changeset ships, not the
    // one that was there when dependencies were installed.
    await generatePrismaClients(dir, log);
    const found = await runSuites(suites, log, commands);
    if (found.some((c) => c.status === "failed")) {
      const ranBaseline = await markPreexisting(dir, found, async () => {
        await generatePrismaClients(dir, []);
        return runSuites(suites, [], []);
      });
      if (ranBaseline) await generatePrismaClients(dir, []);
    }
    cases.push(...found);
  }

  if (await exists(path.join(dir, RULES_SCRIPT))) {
    commands.push(`node ${RULES_SCRIPT}`);
    progress("Checking dependency rules");
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
    return { status: "none", command: "", cases, output: "No test runner found (no vitest, jest or test script) and no typecheck. The rehearsal is the only check.", durationMs: Date.now() - started };
  }
  return {
    status: cases.some((c) => c.status === "failed") ? "failed" : "passed",
    command: commands.join(" && "),
    cases,
    output: log.join("\n\n").slice(-60000),
    durationMs: Date.now() - started,
  };
}
