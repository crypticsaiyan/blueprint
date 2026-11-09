// Records the Blueprint demo by driving the real app in a browser.
//
// Every step really runs: import, agent planning, drawing, rehearsal on the
// sample data, the repo's tests, and (with --pr) the pull request. Waits for
// the agent and the test run are recorded too, then fast-forwarded in the
// final cut with a visible "sped up" badge, so nothing is hidden.
//
// Usage (dev server on :8080):
//   node scripts/record-demo.mjs                              # stops before opening the PR
//   node scripts/record-demo.mjs --pr --pr-repo=owner/repo    # opens the PR too
// Flags: --headed, --theme=dark|light (default dark), --base=URL, --out=DIR (default /tmp/blueprint-demo),
//   --playwright=PATH (playwright-core), --chrome=PATH.
// Output: OUT/raw.mp4, OUT/markers.json, OUT/demo.mp4, OUT/chapters.txt

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const flag = (name, fallback = "") =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;

const require = createRequire(import.meta.url);
const { chromium } = require(
  flag("playwright", "/usr/lib/node_modules/playwright-core"),
);

const BASE = flag("base", "http://localhost:8080");
const OUT = flag("out", "/tmp/blueprint-demo");
const PR_REPO = flag("pr-repo");
const OPEN_PR = process.argv.includes("--pr");
const HEADED = process.argv.includes("--headed");
const CHROME = flag("chrome", "/usr/bin/google-chrome-stable");
const THEME = flag("theme", "dark") === "light" ? "light" : "dark";

const PROMPT =
  "Add multi-tenant orgs. Give users and customers an org, and make user emails unique so each login maps to one account. I'll connect invoices myself. Propose the changeset.";
const SECOND = 1000;
const MINUTE = 60 * SECOND;

fs.mkdirSync(OUT, { recursive: true });
const rawPath = path.join(OUT, "raw.mp4");
const FPS = 30;

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !HEADED,
});
const context = await browser.newContext({
  viewport: { width: 1536, height: 864 },
  deviceScaleFactor: 1.25,
  colorScheme: THEME,
});
const page = await context.newPage();
page.setDefaultTimeout(30 * SECOND);

// Sign in before recording starts.
await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
if (!page.url().includes("/projects")) {
  await page.getByRole("button", { name: /continue as local dev/i }).click();
  await page.waitForURL(/\/(home|projects|chat)/, { timeout: MINUTE });
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
}
await page.waitForTimeout(1500);

// ---- recording helpers -----------------------------------------------------

const markers = [];
let t0 = 0;
const now = () => (Date.now() - t0) / SECOND;
const mark = (kind, label) => {
  markers.push({ t: now(), kind, label });
  console.log(`${now().toFixed(1).padStart(6)}s  ${kind}  ${label}`);
};
const pause = (ms) => page.waitForTimeout(ms);

async function chapter(title, description, ms = 2200) {
  mark("chapter", title);
  await page.screencast.showChapter(title, { description, duration: ms });
  await pause(ms + 200);
}

/** A wait the final cut fast-forwards, with a badge saying so. */
async function fastForward(label, fn) {
  const badge = await page.screencast.showOverlay(
    `<div style="position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;
      padding:6px 14px;border-radius:999px;background:rgba(17,17,17,.88);color:#fff;
      font:500 14px/1.4 ui-sans-serif,system-ui,sans-serif;letter-spacing:.01em">
      ${label} &middot; sped up</div>`,
  );
  mark("ff-start", label);
  try {
    return await fn();
  } finally {
    mark("ff-end", label);
    await badge.dispose();
  }
}

const stopButton = () =>
  page.getByRole("button", { name: "Stop response" }).first();

/** Waits for the agent to start and then finish its turn. */
async function agentTurn(label) {
  await stopButton()
    .waitFor({ state: "visible", timeout: 30 * SECOND })
    .catch(() => {});
  await fastForward(label, () =>
    stopButton().waitFor({ state: "hidden", timeout: 10 * MINUTE }),
  );
  await pause(1500);
}

async function openAgentPanel() {
  const composer = page.locator('[contenteditable="true"], textarea').last();
  if (!(await composer.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Toggle agent" }).click();
    await composer.waitFor({ state: "visible" });
  }
  return composer;
}

async function ask(message, label) {
  const composer = await openAgentPanel();
  await composer.click();
  await composer.pressSequentially(message, { delay: 18 });
  await pause(500);
  await page.keyboard.press("Enter");
  await agentTurn(label);
}

async function fitView() {
  await page
    .getByRole("button", { name: "Fit View" })
    .click()
    .catch(() => {});
  await pause(800);
}

/** Fits the map, then zooms toward the given tables so they read on video. */
async function focusTables(names, zoomSteps = 1, arrange = false) {
  if (arrange) {
    await page
      .getByRole("button", { name: "Arrange" })
      .click()
      .catch(() => {});
    await pause(1500);
  }
  await fitView();
  const boxes = [];
  for (const name of names) {
    const box = await page
      .locator(`.react-flow__node[data-id="${name}"]`)
      .first()
      .boundingBox()
      .catch(() => null);
    if (box) boxes.push(box);
  }
  if (!boxes.length) return;
  const x = boxes.reduce((a, b) => a + b.x + b.width / 2, 0) / boxes.length;
  const y = boxes.reduce((a, b) => a + b.y + b.height / 2, 0) / boxes.length;
  await page.mouse.move(x, y, { steps: 20 });
  for (let i = 0; i < zoomSteps; i++) {
    await page.mouse.wheel(0, -240);
    await pause(250);
  }
  await pause(900);
}

async function collapseNav() {
  const buttons = page.getByRole("button", { name: "Collapse sidebar" });
  for (let i = 0; i < (await buttons.count()); i++) {
    const box = await buttons.nth(i).boundingBox();
    if (box && box.x < 400) {
      await buttons.nth(i).click();
      await pause(700);
      return;
    }
  }
}

async function center(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element is not on screen");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// ---- the demo ---------------------------------------------------------------

// Frames go to the system ffmpeg at a constant rate (the newest frame repeats
// until the page changes), so video time matches wall-clock marker time.
const encoder = spawn(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "-framerate",
    String(FPS),
    "-i",
    "-",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    rawPath,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const encoded = new Promise((resolve, reject) =>
  encoder.on("close", (code) =>
    code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
  ),
);
let lastFrame = null;
let written = 0;
await page.screencast.start({
  size: { width: 1920, height: 1080 },
  quality: 90,
  fps: FPS,
  onFrame: ({ data }) => {
    lastFrame = data;
  },
});
t0 = Date.now();
const pump = () => {
  if (!lastFrame) return;
  const due = Math.floor(((Date.now() - t0) / SECOND) * FPS);
  for (; written < due; written++) encoder.stdin.write(lastFrame);
};
const ticker = setInterval(pump, 1000 / FPS);
await page.screencast.showActions({
  cursor: "pointer",
  duration: 700,
  style: {
    title: "display:none",
    point:
      "width:26px;height:26px;border-radius:50%;background:rgba(37,99,235,.25)",
  },
});

try {
  // 1. The problem.
  await chapter(
    "Blueprint",
    "See what a Postgres schema change breaks before production does.",
    2600,
  );
  await chapter(
    "Migrations are scary",
    "A migration passes review, then trips over real data and code nobody knew touched that table.",
    3000,
  );

  // 2. Import.
  await chapter(
    "1. Import a repo",
    "Tallyhub: an invoicing SaaS with Drizzle queries, tests, and messy data.",
  );
  await page.getByRole("button", { name: "Import repository" }).click();
  await pause(1200);
  await page
    .getByRole("button", { name: /Use the demo repo|Tallyhub/ })
    .first()
    .click();
  await fastForward("Importing", () =>
    page.waitForURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 3 * MINUTE }),
  );
  const projectId = page.url().split("/").pop();
  mark("project", projectId);
  await pause(1500);
  await collapseNav();
  await pause(2000);
  // Show the code layer: which module reads or writes which table.
  await page
    .getByRole("button", { name: "Code layer" })
    .click()
    .catch(() => {});
  await pause(2500);
  await page
    .getByRole("button", { name: "Code layer" })
    .click()
    .catch(() => {});
  await pause(1000);

  // 3. Ask the agent.
  await chapter(
    "2. Ask for the change",
    "The agent proposes ghost tables and columns, each with a reason.",
  );
  await ask(PROMPT, "Agent planning");
  await focusTables(["orgs", "users", "customers", "invoices"], 1, true);
  await pause(3500);

  // 4. Draw a relationship the agent left out.
  const orgs = (await page.locator('.react-flow__node[data-id="orgs"]').count())
    ? "orgs"
    : await page.evaluate(() =>
        [...document.querySelectorAll(".react-flow__node")]
          .map((n) => n.getAttribute("data-id"))
          .find((id) => /^(orgs|organizations|tenants)$/.test(id ?? "")),
      );
  if (!orgs) throw new Error("The agent's plan has no orgs table to draw to.");
  const linked = async (table) =>
    (await page
      .locator(
        `.react-flow__edge[data-id$=":${table}.${orgs.replace(/s$/, "")}_id"]`,
      )
      .count()) > 0;
  let from = null;
  for (const table of [
    "invoices",
    "projects",
    "payments",
    "invoice_items",
    "comments",
  ]) {
    if (
      (await page.locator(`.react-flow__node[data-id="${table}"]`).count()) &&
      !(await linked(table))
    ) {
      from = table;
      break;
    }
  }
  if (from) {
    await chapter(
      `3. Draw ${from} → ${orgs}`,
      "Drag a line. Blueprint proposes the column, the backfill, and the foreign key.",
    );
    await focusTables([from, orgs], 1);
    const source = await center(
      page
        .locator(
          `.react-flow__node[data-id="${from}"] .react-flow__handle-left`,
        )
        .first(),
    );
    const target = await center(
      page
        .locator(
          `.react-flow__node[data-id="${orgs}"] .react-flow__handle-right`,
        )
        .first(),
    );
    await page.mouse.move(source.x - 60, source.y - 40, { steps: 15 });
    await page.mouse.move(source.x, source.y, { steps: 12 });
    await page.mouse.down();
    await page.mouse.move(
      (source.x + target.x) / 2,
      Math.min(source.y, target.y) - 60,
      { steps: 25 },
    );
    await page.mouse.move(target.x, target.y, { steps: 25 });
    await pause(300);
    await page.mouse.up();
    const edge = page
      .locator(
        `.react-flow__edge[data-id$=":${from}.${orgs.replace(/s$/, "")}_id"]`,
      )
      .first();
    await edge.waitFor({ state: "attached", timeout: MINUTE });
    await pause(2500);
    await edge
      .locator("path")
      .last()
      .click({ force: true })
      .catch(() => {});
    await pause(3500);
    await page.keyboard.press("Escape").catch(() => {});
  } else {
    mark("skip", "every candidate table already points at orgs");
  }

  // 5. Steer: reject and lock one ghost, then re-plan.
  await chapter(
    "4. Steer the plan",
    "Reject and lock a ghost. The agent re-plans around it and never proposes it again.",
  );
  // Reject one of the agent's own proposals, never the relationship just drawn.
  const rows = page
    .locator("aside li:has(button[aria-label='Reject'])")
    .filter({ hasNotText: "drawn" });
  let row = null;
  for (const pattern of [/^Index/, /^Foreign key/, /NOT NULL/]) {
    const match = rows.filter({ hasText: pattern }).first();
    if (await match.count()) {
      row = match;
      break;
    }
  }
  row ??= rows.last();
  await row.scrollIntoViewIfNeeded();
  await pause(800);
  await row.getByRole("button", { name: "Reject" }).click();
  await pause(1200);
  await row.getByRole("button", { name: "Lock" }).click();
  await pause(1500);
  await page.getByRole("button", { name: "Re-plan" }).click();
  await agentTurn("Agent re-planning");
  await focusTables(["orgs", "users", "customers", "invoices"], 1, true);
  await pause(2500);

  // 6. Rehearse on a copy of the data.
  await chapter(
    "5. Rehearse",
    "The migration runs on a PGlite copy of the sample data. Every changed row is shown.",
  );
  const rehearseButton = page.getByRole("button", {
    name: "Rehearse",
    exact: true,
  });
  if (await rehearseButton.isVisible().catch(() => false)) {
    await rehearseButton.click();
    await fastForward("Rehearsing", () =>
      page.waitForURL(/\/rehearse$/, { timeout: 5 * MINUTE }),
    );
  } else {
    await page
      .getByRole("link", { name: /Rehearse/ })
      .first()
      .click();
    await page.waitForURL(/\/rehearse$/);
  }
  await pause(2500);
  const replay = page.getByRole("button", { name: "Replay" });
  if (await replay.isVisible().catch(() => false)) {
    await replay.click();
    await pause(5000);
  }

  // Conflicts: pick a fix for each.
  // Prefer fixes that keep data: merge duplicates, null out orphans, leave a column nullable.
  const preferred = [
    "merge_duplicates",
    "set_null",
    "skip",
    "rename_duplicates",
    "delete_rows",
  ];
  const openConflicts = () =>
    page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: "Apply fix" }) })
      .filter({ hasNotText: "Fixed:" })
      .filter({ has: page.locator("header svg.text-conflict") });
  for (let i = 0; i < 10; i++) {
    const conflict = openConflicts().first();
    if (!(await conflict.count())) break;
    if (i === 0)
      await chapter(
        "Conflicts",
        "Duplicates, nulls, and orphaned rows that would fail in production. You pick each fix.",
        3000,
      );
    await conflict.scrollIntoViewIfNeeded();
    await pause(2500);
    const values = await conflict
      .locator("input[type=radio]")
      .evaluateAll((els) => els.map((e) => e.value));
    const fix = preferred.find((p) => values.includes(p));
    if (!fix)
      throw new Error(
        `No fix without a value for this conflict: ${values.join(", ")}`,
      );
    await conflict.locator(`input[type=radio][value="${fix}"]`).check();
    await pause(1200);
    const heading = (
      await conflict.locator("header").first().innerText()
    ).trim();
    await conflict.getByRole("button", { name: "Apply fix" }).click();
    const applying = page.getByRole("button", { name: "Applying…" });
    await applying
      .first()
      .waitFor({ state: "visible", timeout: 5 * SECOND })
      .catch(() => {});
    await fastForward("Re-running rehearsal", () =>
      applying.first().waitFor({ state: "hidden", timeout: 5 * MINUTE }),
    );
    await pause(2000);
    // The view refreshes after the re-run; give it time before calling the fix a failure.
    const stillOpen = async () => {
      const next = openConflicts().first();
      return (
        (await next.count()) > 0 &&
        (await next.locator("header").first().innerText()).trim() === heading
      );
    };
    for (let wait = 0; wait < 15 && (await stillOpen()); wait++)
      await pause(SECOND);
    if (await stillOpen())
      throw new Error(`The fix did not clear the conflict: ${heading}`);
  }
  const again = page.getByRole("button", { name: "Rehearse", exact: true });
  if (await again.isVisible().catch(() => false)) {
    await again.click();
    await fastForward("Rehearsing", () =>
      page
        .getByRole("button", { name: "Rehearsing…" })
        .waitFor({ state: "hidden", timeout: 5 * MINUTE }),
    );
  }
  await page.mouse.wheel(0, -4000);
  await pause(2500);

  // 7. Tests, fixed by the agent.
  await chapter(
    "6. Fix the code, run the tests",
    "The repo's own tests run against the migrated data. The agent fixes what breaks.",
  );
  await page.getByRole("link", { name: /Ship/ }).first().click();
  await page.waitForURL(/\/ship$/);
  await pause(2500);
  const runTests = page.getByRole("button", { name: "Run tests" });
  const cancelRun = page.getByRole("button", { name: /Cancel run|Cancelling/ });
  const testsDone = () =>
    cancelRun.waitFor({ state: "hidden", timeout: 20 * MINUTE });
  await runTests.click();
  await cancelRun
    .waitFor({ state: "visible", timeout: MINUTE })
    .catch(() => {});
  await fastForward("Running tests", testsDone);
  await pause(3500);
  for (let round = 0; round < 2; round++) {
    const fixButton = page
      .getByRole("button", { name: "Fix with agent" })
      .first();
    if (!(await fixButton.isVisible().catch(() => false))) break;
    await fixButton.click();
    await agentTurn("Agent fixing queries and re-running tests");
    await fastForward("Running tests", testsDone);
    await pause(3500);
  }

  // Walk the diff.
  await pause(2500);

  // 8. Pull request.
  await chapter(
    "7. Open the PR",
    "Migration, backfill, Drizzle schema, fixed queries, and passing tests in one pull request.",
  );
  if (PR_REPO) {
    await page.locator("#pr-repo").fill("");
    await page.locator("#pr-repo").pressSequentially(PR_REPO, { delay: 40 });
    await pause(800);
  }
  if (OPEN_PR) {
    await page.getByRole("button", { name: "Create PR" }).click();
    await fastForward("Opening pull request", () =>
      page
        .getByRole("link", { name: /View PR #\d+/ })
        .waitFor({ state: "visible", timeout: 5 * MINUTE }),
    );
    await pause(4000);
  } else {
    mark("skip", "PR not opened (run with --pr to open it)");
    await page
      .getByRole("button", { name: "Create PR" })
      .hover({ force: true, timeout: 2000 })
      .catch(() => {});
    await pause(2000);
  }

  await chapter(
    "Built on Agent-Native",
    "Every button here is an action the agent can call too. You and the agent share one plan, one rehearsal, one PR.",
    5000,
  );
  mark("end", "done");
} catch (error) {
  mark("error", String(error?.message ?? error));
  await page.screenshot({ path: path.join(OUT, "error.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  pump();
  clearInterval(ticker);
  await page.screencast.stop();
  encoder.stdin.end();
  await encoded;
  fs.writeFileSync(
    path.join(OUT, "markers.json"),
    JSON.stringify(markers, null, 2),
  );
  await browser.close();
}

// ---- final cut: fast-forward the waits --------------------------------------

const KEEP = 2; // seconds a wait lasts in the final cut
const segments = [];
let cursor = 0;
for (let i = 0; i < markers.length; i++) {
  const start = markers[i];
  if (start.kind !== "ff-start") continue;
  const end = markers
    .slice(i + 1)
    .find((m) => m.kind === "ff-end" && m.label === start.label);
  if (!end || end.t - start.t <= KEEP) continue;
  segments.push({ from: cursor, to: start.t, speed: 1 });
  segments.push({
    from: start.t,
    to: end.t,
    speed: Math.min((end.t - start.t) / KEEP, 60),
  });
  cursor = end.t;
}
segments.push({ from: cursor, to: null, speed: 1 });

const filters = segments.map((s, i) => {
  const trim =
    s.to == null ? `trim=start=${s.from}` : `trim=start=${s.from}:end=${s.to}`;
  return `[0:v]${trim},setpts=(PTS-STARTPTS)/${s.speed.toFixed(3)},fps=30[v${i}]`;
});
const graph = `${filters.join(";")};${segments.map((_, i) => `[v${i}]`).join("")}concat=n=${segments.length}:v=1:a=0[out]`;
const finalPath = path.join(OUT, "demo.mp4");
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-i",
    rawPath,
    "-filter_complex",
    graph,
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    finalPath,
  ],
  { stdio: "inherit" },
);

// Chapter times in the final cut, for lining up a voiceover.
const outTime = (t) => {
  let acc = 0;
  for (const s of segments) {
    const to = s.to ?? Infinity;
    if (t <= to) return acc + (t - s.from) / s.speed;
    acc += (to - s.from) / s.speed;
  }
  return acc;
};
const fmt = (s) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const chapters = markers
  .filter((m) => m.kind === "chapter")
  .map((m) => `${fmt(outTime(m.t))}  ${m.label}`);
fs.writeFileSync(path.join(OUT, "chapters.txt"), chapters.join("\n") + "\n");
console.log(`\nFinal cut: ${finalPath}\n${chapters.join("\n")}`);
