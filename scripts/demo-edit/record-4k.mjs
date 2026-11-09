// Records the Blueprint demo in 4K by driving the real app in a visible Chrome
// window on a virtual Hyprland monitor, captured with wf-recorder. Nothing
// shows on the physical screens.
//
// Every step really runs: import, agent planning, drawing, rehearsal on the
// sample data, the repo's tests, and (with --pr) the pull request. The script
// logs markers for edit.mjs: chapters, fast-forward spans, focus boxes (where
// the camera should look), and voiceover cues.
//
// Usage (dev server on :8080, Hyprland session):
//   node scripts/demo-edit/record-4k.mjs --out=DIR [--pr --pr-repo=owner/repo]
// Flags: --theme=dark|light (default dark), --base=URL, --monitor=NAME (default BPDEMO),
//   --playwright=PATH, --chrome=PATH.
// Output: OUT/raw.mp4 (3840x2160), OUT/markers.json

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
const OUT = flag("out");
if (!OUT) throw new Error("--out=DIR is required");
const PR_REPO = flag("pr-repo");
const OPEN_PR = process.argv.includes("--pr");
const CHROME = flag("chrome", "/usr/bin/google-chrome-stable");
const THEME = flag("theme", "dark") === "light" ? "light" : "dark";
// "main" records the whole flow; "tour" walks an existing project's code impact,
// migration SQL, and the agent's code fix (no writes).
const SCENE = flag("scene", "main");
const PROJECT = flag("project");
if (SCENE !== "main" && !PROJECT)
  throw new Error(`--scene=${SCENE} needs --project=ID`);
const MONITOR = flag("monitor", "BPDEMO");
// For the features scene: which steps to record (default all).
const STEPS = new Set(
  flag("steps", "dashboard,map,inspect,module,draw,drawtable,rule").split(","),
);

const PROMPT =
  "Add multi-tenant orgs. Give users and customers an org, and make user emails unique so each login maps to one account. I'll connect invoices myself. Propose the changeset.";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const VIEW = { width: 1536, height: 864 };

fs.mkdirSync(OUT, { recursive: true });
const rawPath = path.join(OUT, "raw.mp4");

// ---- virtual monitor ----------------------------------------------------------

const hypr = (...args) => execFileSync("hyprctl", args).toString();
const monitors = () => JSON.parse(hypr("monitors", "-j"));
let createdMonitor = false;
if (!monitors().some((m) => m.name === MONITOR)) {
  hypr("output", "create", "headless", MONITOR);
  createdMonitor = true;
}
// 3840x2160 at scale 2, with Chrome at 1.25x on top: a 1536x864 CSS viewport at 2.5x.
hypr(
  "eval",
  `hl.monitor({ output = "${MONITOR}", mode = "3840x2160@30", position = "9000x0", scale = "2" })`,
);
const workspace = monitors().find((m) => m.name === MONITOR).activeWorkspace.id;

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: false,
  args: [
    "--ozone-platform=wayland",
    "--force-device-scale-factor=1.25",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-infobars",
  ],
  ignoreDefaultArgs: ["--enable-automation"],
});
const context = await browser.newContext({
  viewport: null,
  colorScheme: THEME,
});

// A drawn cursor with a click ripple; Playwright's mouse does not move the system pointer.
await context.addInitScript(() => {
  const install = () => {
    if (document.getElementById("__demo_cursor")) return;
    const c = document.createElement("div");
    c.id = "__demo_cursor";
    c.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4.5 2.5l15 8.6-6.9 1.7-3.4 6.4z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    const saved = JSON.parse(
      sessionStorage.getItem("__demo_cursor") ?? '{"x":-100,"y":-100}',
    );
    Object.assign(c.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: `translate(${saved.x - 4}px, ${saved.y - 2}px)`,
      filter: "drop-shadow(0 1px 2px rgba(0,0,0,.45))",
    });
    document.documentElement.appendChild(c);
    addEventListener(
      "mousemove",
      (e) => {
        c.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 2}px)`;
        sessionStorage.setItem(
          "__demo_cursor",
          JSON.stringify({ x: e.clientX, y: e.clientY }),
        );
      },
      true,
    );
    addEventListener(
      "mousedown",
      (e) => {
        const r = document.createElement("div");
        Object.assign(r.style, {
          position: "fixed",
          left: `${e.clientX - 16}px`,
          top: `${e.clientY - 16}px`,
          width: "32px",
          height: "32px",
          borderRadius: "50%",
          background: "rgba(255,255,255,.28)",
          zIndex: "2147483646",
          pointerEvents: "none",
          transition:
            "transform .5s cubic-bezier(.2,.7,.3,1), opacity .5s ease-out",
        });
        document.documentElement.appendChild(r);
        requestAnimationFrame(() => {
          r.style.transform = "scale(1.9)";
          r.style.opacity = "0";
        });
        setTimeout(() => r.remove(), 550);
      },
      true,
    );
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", install);
  else install();
});

const page = await context.newPage();
page.setDefaultTimeout(30 * SECOND);
// A unique title identifies our window among any other Chrome windows.
const nonce = `bpdemo-${Date.now()}`;
await page.goto(`data:text/html,<title>${nonce}</title>`);
let ours = null;
for (let i = 0; i < 20 && !ours; i++) {
  await page.waitForTimeout(250);
  ours = JSON.parse(hypr("clients", "-j")).find((c) => c.title.includes(nonce));
}
if (!ours) {
  await browser.close();
  throw new Error("Could not find the demo Chrome window in Hyprland.");
}
const client = () =>
  JSON.parse(hypr("clients", "-j")).find((c) => c.address === ours.address);
/** Keeps the demo window full screen on the virtual monitor's workspace. */
async function placeWindow() {
  for (let i = 0; i < 12; i++) {
    const c = client();
    const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    if (
      c?.workspace.id === workspace &&
      c.fullscreen &&
      size.w === VIEW.width &&
      size.h === VIEW.height
    )
      return;
    if (c?.workspace.id !== workspace) {
      hypr(
        "dispatch",
        `hl.dsp.window.move({ workspace = ${workspace}, window = "address:${ours.address}" })`,
      );
    } else if (!c.fullscreen) {
      hypr(
        "dispatch",
        `hl.dsp.window.fullscreen({ mode = [[fullscreen]], action = [[set]], window = "address:${ours.address}" })`,
      );
    }
    await page.waitForTimeout(700);
  }
  const c = client();
  const size = await page.evaluate(() => ({
    w: innerWidth,
    h: innerHeight,
    dpr: devicePixelRatio,
  }));
  throw new Error(
    `Window not placed: workspace ${c?.workspace.id}, fullscreen ${c?.fullscreen}, viewport ${size.w}x${size.h} at ${size.dpr}x.`,
  );
}
try {
  await placeWindow();
} catch (error) {
  await browser.close();
  throw error;
}

// Sign in before recording starts.
await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
if (!page.url().includes("/projects")) {
  await page.getByRole("button", { name: /continue as local dev/i }).click();
  await page.waitForURL(/\/(home|projects|chat)/, { timeout: MINUTE });
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
}
if (SCENE === "tour" || (SCENE === "features" && !STEPS.has("dashboard"))) {
  await page.goto(`${BASE}/projects/${encodeURIComponent(PROJECT)}`, {
    waitUntil: "networkidle",
  });
}
await page.waitForTimeout(1500);

// ---- markers ------------------------------------------------------------------

const markers = [];
let t0 = 0;
const now = () => (Date.now() - t0) / SECOND;
const mark = (kind, label, extra = {}) => {
  markers.push({ t: now(), kind, label, ...extra });
  console.log(`${now().toFixed(1).padStart(6)}s  ${kind}  ${label}`);
};
const pause = (ms) => page.waitForTimeout(ms);
const chapter = async (id) => {
  await placeWindow();
  mark("chapter", id);
  await pause(400);
};
const cue = (id) => mark("cue", id);

async function boxOf(locator) {
  const box = await locator.boundingBox().catch(() => null);
  return box ? [box.x, box.y, box.width, box.height] : null;
}
const union = (...boxes) => {
  const b = boxes.filter(Boolean);
  if (!b.length) return null;
  const x = Math.min(...b.map((r) => r[0]));
  const y = Math.min(...b.map((r) => r[1]));
  return [
    x,
    y,
    Math.max(...b.map((r) => r[0] + r[2])) - x,
    Math.max(...b.map((r) => r[1] + r[3])) - y,
  ];
};
/** Tells the editor where the camera should look from now on ("full" for the whole window). */
async function focus(target, pad = 32) {
  const rect =
    target === "full"
      ? null
      : Array.isArray(target)
        ? target
        : await boxOf(target);
  if (target !== "full" && !rect) return;
  mark("focus", target === "full" ? "full" : "box", { rect, pad });
}

/** A wait the editor fast-forwards. */
async function fastForward(label, fn) {
  mark("ff-start", label);
  try {
    return await fn();
  } finally {
    mark("ff-end", label);
  }
}

// ---- pointer --------------------------------------------------------------------

let pointer = { x: VIEW.width / 2, y: VIEW.height / 2 };
const easeInOut = (x) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
async function moveTo(x, y, ms) {
  const dist = Math.hypot(x - pointer.x, y - pointer.y);
  const duration = ms ?? Math.min(900, 280 + dist * 0.7);
  const steps = Math.max(8, Math.round(duration / 16));
  const from = pointer;
  for (let i = 1; i <= steps; i++) {
    const e = easeInOut(i / steps);
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await page.waitForTimeout(duration / steps);
  }
  pointer = { x, y };
}
async function click(locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error("element is not on screen");
  await moveTo(box.x + box.width / 2, box.y + box.height / 2);
  await pause(140);
  await page.mouse.down();
  await pause(70);
  await page.mouse.up();
}

// ---- app helpers ----------------------------------------------------------------

const stopButton = () =>
  page.getByRole("button", { name: "Stop response" }).first();
async function agentTurn(label) {
  await stopButton()
    .waitFor({ state: "visible", timeout: 30 * SECOND })
    .catch(() => {});
  await fastForward(label, () =>
    stopButton().waitFor({ state: "hidden", timeout: 10 * MINUTE }),
  );
  await pause(1500);
}

const agentPanel = async () => {
  const composer = page.locator('[contenteditable="true"], textarea').last();
  return { composer, box: await boxOf(composer) };
};
const inspector = () =>
  page
    .locator("aside")
    .filter({ hasText: /Changeset|All changes|Proposed relationship/i })
    .first();

async function fitView() {
  await click(page.getByRole("button", { name: "Fit View" })).catch(() => {});
  await pause(700);
}
async function arrange() {
  await click(page.getByRole("button", { name: "Arrange" })).catch(() => {});
  await pause(1300);
  await fitView();
}
async function zoomToward(names, steps = 1) {
  const boxes = [];
  for (const name of names)
    boxes.push(
      await boxOf(page.locator(`.react-flow__node[data-id="${name}"]`).first()),
    );
  const r = union(...boxes);
  if (!r) return;
  await moveTo(r[0] + r[2] / 2, r[1] + r[3] / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, -240);
    await pause(250);
  }
  await pause(700);
}
const tables = async (names) => {
  const boxes = [];
  for (const name of names)
    boxes.push(
      await boxOf(page.locator(`.react-flow__node[data-id="${name}"]`).first()),
    );
  return union(...boxes);
};

// ---- record ----------------------------------------------------------------------

const recorder = spawn(
  "wf-recorder",
  [
    "-y",
    "-o",
    MONITOR,
    "-r",
    "30",
    "-c",
    "libx264",
    "-p",
    "preset=ultrafast",
    "-p",
    "crf=14",
    "-f",
    rawPath,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let recorderLog = "";
recorder.stderr.on("data", (d) => (recorderLog += d));
const recorded = new Promise((resolve) => recorder.on("close", resolve));
for (
  let i = 0;
  i < 100 && !(fs.existsSync(rawPath) && fs.statSync(rawPath).size > 0);
  i++
)
  await pause(50);
t0 = Date.now();
// Watchdog: if anything moves the window off the recorded workspace, put it back.
const watchdog = setInterval(() => {
  try {
    const c = client();
    const active = monitors().find((m) => m.name === MONITOR)?.activeWorkspace
      .id;
    if (
      c?.workspace.id !== workspace ||
      !c.fullscreen ||
      active !== workspace
    ) {
      mark(
        "window-fix",
        `ws ${c?.workspace.id} fs ${c?.fullscreen} active ${active}`,
      );
      if (active !== workspace)
        hypr("dispatch", `hl.dsp.focus({ workspace = ${workspace} })`);
      if (c?.workspace.id !== workspace) {
        hypr(
          "dispatch",
          `hl.dsp.window.move({ workspace = ${workspace}, window = "address:${ours.address}" })`,
        );
      }
      if (!c?.fullscreen) {
        hypr(
          "dispatch",
          `hl.dsp.window.fullscreen({ mode = [[fullscreen]], action = [[set]], window = "address:${ours.address}" })`,
        );
      }
    }
  } catch {
    // hyprctl hiccup; try again next tick.
  }
}, 1500);

try {
  if (SCENE === "tour") await tour();
  else if (SCENE === "features") await features();
  else await mainScene();
} catch (error) {
  mark("error", String(error?.message ?? error));
  await page.screenshot({ path: path.join(OUT, "error.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  clearInterval(watchdog);
  recorder.kill("SIGINT");
  await recorded;
  fs.writeFileSync(
    path.join(OUT, "markers.json"),
    JSON.stringify(markers, null, 2),
  );
  await browser.close();
  if (createdMonitor) hypr("output", "remove", MONITOR);
  if (recorderLog.trim())
    fs.writeFileSync(path.join(OUT, "wf-recorder.log"), recorderLog);
}
console.log(`\nRaw take: ${rawPath}`);

/** Clicks the middle of an SVG path (edges have no box worth aiming at). */
async function clickPath(locator) {
  const point = await locator.evaluate((path) => {
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM();
    return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
  });
  await moveTo(point.x, point.y);
  await pause(140);
  await page.mouse.down();
  await pause(70);
  await page.mouse.up();
  return point;
}

async function closeAgent() {
  if (
    !(await page
      .locator('[contenteditable="true"], textarea')
      .last()
      .isVisible()
      .catch(() => false))
  )
    return;
  const toggle = page.getByRole("button", { name: "Toggle agent" });
  if (await toggle.isVisible().catch(() => false)) return click(toggle);
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  for (let i = 0; i < (await collapse.count()); i++) {
    const b = await collapse.nth(i).boundingBox();
    if (b && b.x > 1000) return click(collapse.nth(i));
  }
}

async function showModules() {
  if (!(await page.locator('.react-flow__node[data-id^="module:"]').count())) {
    await click(page.getByRole("button", { name: "Code layer" }));
    await pause(900);
  }
}

/** The product tour: real repos, the map, inspecting, drawing, and rules. */
async function features() {
  if (!STEPS.has("dashboard")) {
    await pause(800);
    const collapse = page.getByRole("button", { name: "Collapse sidebar" });
    for (let i = 0; i < (await collapse.count()); i++) {
      const b = await collapse.nth(i).boundingBox();
      if (b && b.x < 400) {
        await click(collapse.nth(i));
        break;
      }
    }
    await closeAgent();
    await arrange();
  }
  if (STEPS.has("dashboard")) {
    // Real repos already imported.
    await pause(1000);
    await chapter("dashboard");
    await focus("full");
    cue("dashboard-1");
    const rows = page.locator("table tbody tr, [role='row']");
    for (const name of [
      "documenso",
      "rallly",
      "kan",
      "nextjs-subscription-payments",
    ]) {
      const row = page.getByText(name, { exact: true }).first();
      if (await row.count()) {
        const b = await boxOf(row);
        if (b) await moveTo(b[0] + 160, b[1] + b[3] / 2, 700);
        await pause(900);
      }
    }
    await pause(800);
    await page.goto(`${BASE}/projects/${encodeURIComponent(PROJECT)}`, {
      waitUntil: "networkidle",
    });
    await pause(900);
  }

  // The map.
  if (STEPS.has("map")) {
    await chapter("map");
    const collapse = page.getByRole("button", { name: "Collapse sidebar" });
    for (let i = 0; i < (await collapse.count()); i++) {
      const b = await collapse.nth(i).boundingBox();
      if (b && b.x < 400) {
        await click(collapse.nth(i));
        break;
      }
    }
    if (
      await page
        .locator('[contenteditable="true"], textarea')
        .last()
        .isVisible()
        .catch(() => false)
    ) {
      await click(page.getByRole("button", { name: "Toggle agent" }));
    }
    await arrange();
    await focus("full");
    cue("map-1");
    await pause(3500);
    cue("map-2");
    for (const name of ["Select", "Draw table", "Code layer", "Arrange"]) {
      await moveTo(
        ...(await (async () => {
          const b = await boxOf(
            page.getByRole("button", { name, exact: true }).first(),
          );
          return b
            ? [b[0] + b[2] / 2, b[1] + b[3] / 2]
            : [pointer.x, pointer.y];
        })()),
        450,
      );
      await pause(1100);
    }
    await showModules();
    await pause(2500);
  }

  // Inspect a table: columns, pending changes, queries, and real rows.
  if (STEPS.has("inspect")) {
    await chapter("inspect");
    const customers = page
      .locator('.react-flow__node[data-id="customers"]')
      .first();
    await click(customers.locator("div").first());
    await pause(900);
    cue("inspect-1");
    {
      const insp = await boxOf(inspector());
      await focus(insp ? [insp[0], 0, insp[2], 700] : "full", 16);
    }
    await pause(3500);
    await click(page.getByRole("tab", { name: "Data" }));
    await pause(900);
    cue("inspect-2");
    await focus(
      await boxOf(page.locator('[role="tablist"]').first().locator("..")),
      16,
    );
    await pause(4000);
  }

  // Inspect a code module: its queries and imports.
  if (STEPS.has("module")) {
    await chapter("module");
    await focus("full");
    await showModules();
    const moduleNode = page
      .locator('.react-flow__node[data-id^="module:"]')
      .first();
    if (await moduleNode.count()) {
      await click(moduleNode);
      await pause(900);
      cue("module-1");
      const insp = await boxOf(inspector());
      await focus(insp ? [insp[0], 0, insp[2], 700] : "full", 16);
      await pause(4000);
    }
    await page.keyboard.press("Escape").catch(() => {});
    await click(page.getByRole("tab", { name: "Data" })).catch(() => {});
    await click(page.getByRole("button", { name: "Collapse panel" })).catch(
      () => {},
    );
    await pause(600);
  }

  // Draw a relationship, with the connection line visible.
  if (STEPS.has("draw")) {
    await chapter("draw");
    await page.keyboard.press("Escape").catch(() => {});
    await arrange();
    const orgs = "orgs";
    const orgsBox = await boxOf(
      page.locator(`.react-flow__node[data-id="${orgs}"]`).first(),
    );
    // The unlinked table closest to orgs, so both sit on screen and the line is short.
    let from = null;
    let best = Infinity;
    for (const table of [
      "invoices",
      "payments",
      "comments",
      "invoice_items",
      "projects",
      "api_keys",
    ]) {
      if (
        !(await page.locator(`.react-flow__node[data-id="${table}"]`).count())
      )
        continue;
      if (
        await page
          .locator(`.react-flow__edge[data-id$=":${table}.org_id"]`)
          .count()
      )
        continue;
      const b = await boxOf(
        page.locator(`.react-flow__node[data-id="${table}"]`).first(),
      );
      const d =
        b && orgsBox
          ? Math.hypot(b[0] - orgsBox[0], b[1] - orgsBox[1])
          : Infinity;
      if (d < best) {
        best = d;
        from = table;
      }
    }
    if (from) {
      mark("draw-from", from);
      // No browser zoom: both tables stay fully on screen; the edit zooms gently instead.
      // Arrange fits the view on a delay; let it settle before measuring handles.
      await pause(1500);
      await fitView();
      await pause(1200);
      await focus(await tables([from, orgs]), 60);
      await pause(800);
      cue("draw-1");
      const handle = async (table, side) => {
        const b = await boxOf(
          page
            .locator(
              `.react-flow__node[data-id="${table}"] .react-flow__handle-${side}`,
            )
            .first(),
        );
        return { x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 };
      };
      const source = await handle(from, "left");
      const target = await handle(orgs, "right");
      await moveTo(source.x, source.y);
      await pause(350);
      await page.mouse.down();
      await moveTo(target.x, target.y, 1800);
      await pause(500);
      await page.mouse.up();
      await page
        .locator(`.react-flow__edge[data-id$=":${from}.org_id"]`)
        .first()
        .waitFor({ state: "attached", timeout: MINUTE });
      await pause(400);
      cue("draw-2");
      const toastBox = await boxOf(page.locator("[data-sonner-toast]").last());
      await focus(
        toastBox ? union(toastBox, await tables([from, orgs])) : "full",
        40,
      );
      await pause(5000);
    }
  }

  // Draw a new table; the agent fills in its columns.
  if (STEPS.has("drawtable")) {
    await chapter("drawtable");
    await fitView();
    await focus("full");
    await click(page.getByRole("button", { name: "Draw table", exact: true }));
    await pause(500);
    const canvas = await boxOf(page.locator(".react-flow").first());
    const start = { x: canvas[0] + 90, y: canvas[1] + canvas[3] - 230 };
    cue("drawtable-1");
    await moveTo(start.x, start.y);
    await page.mouse.down();
    await moveTo(start.x + 230, start.y + 120, 700);
    await page.mouse.up();
    await pause(400);
    const tableName = (await page
      .locator('.react-flow__node[data-id="audit_events"]')
      .count())
      ? "audit_log"
      : "audit_events";
    await page.keyboard.type(tableName, { delay: 70 });
    await pause(400);
    await page.keyboard.press("Enter");
    await pause(600);
    {
      const p = await agentPanel();
      await focus(
        p.box ? [p.box[0] - 20, 0, VIEW.width - p.box[0] + 20, 620] : "full",
        0,
      );
    }
    await agentTurn("Agent filling columns");
    await fitView();
    const drawn = await boxOf(
      page.locator('.react-flow__node[data-id="audit_events"]').first(),
    );
    await focus(drawn ?? "full", 120);
    cue("drawtable-2");
    await pause(4000);
  }

  // Forbid a module dependency; the agent is asked to fix the violation.
  if (STEPS.has("rule")) {
    await chapter("rule");
    await focus("full");
    await closeAgent();
    await fitView();
    await showModules();
    const dep = page.locator('.react-flow__edge[data-id^="dep:"]').first();
    if (await dep.count()) {
      const point = await clickPath(dep.locator("path").first());
      await pause(900);
      cue("rule-1");
      const insp = await boxOf(inspector());
      await focus(
        insp
          ? union(
              [insp[0], 0, insp[2], 380],
              [point.x - 150, point.y - 80, 300, 160],
            )
          : "full",
        24,
      );
      const reason = page.getByRole("textbox", { name: /Why\?/ });
      if (await reason.count()) {
        await click(reason);
        await reason.pressSequentially(
          "Reports must not reach into billing internals.",
          { delay: 30 },
        );
        await pause(500);
      }
      await click(page.getByRole("button", { name: "Forbid this dependency" }));
      await pause(1200);
      cue("rule-2");
      await focus([point.x - 300, point.y - 160, 600, 320], 40);
      await pause(3500);
    }
  }

  await chapter("end");
  await focus("full");
  await pause(800);
  mark("end", "done");
}

async function tour() {
  await pause(1200);
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  for (let i = 0; i < (await collapse.count()); i++) {
    const b = await collapse.nth(i).boundingBox();
    if (b && b.x < 400) {
      await click(collapse.nth(i));
      break;
    }
  }
  if (
    await page
      .locator('[contenteditable="true"], textarea')
      .last()
      .isVisible()
      .catch(() => false)
  ) {
    await click(page.getByRole("button", { name: "Toggle agent" }));
  }
  await pause(800);
  await arrange();
  const panel = () => page.locator('[role="tablist"]').first().locator("..");

  // Code impact: which queries the change breaks, with file and line.
  await chapter("impact");
  await focus("full");
  await pause(800);
  await click(page.getByRole("tab", { name: /Code impact/ }));
  await pause(700);
  cue("impact-1");
  await focus(await boxOf(panel()), 16);
  await pause(7000);

  // The generated migration.
  await chapter("sql");
  await click(page.getByRole("tab", { name: "Migration SQL" }));
  await pause(700);
  cue("sql-1");
  const sqlBox = await boxOf(panel());
  if (sqlBox) {
    await moveTo(sqlBox[0] + sqlBox[2] / 2, sqlBox[1] + sqlBox[3] / 2);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 160);
      await pause(900);
    }
  }
  await pause(1500);

  // The agent's code fix, in the pull request diff.
  await chapter("diff");
  await focus("full");
  await click(page.getByRole("link", { name: /Ship/ }).first());
  await page.waitForURL(/\/ship$/);
  await pause(1500);
  const fixRow = page
    .locator("button")
    .filter({ hasText: "agent fix" })
    .first();
  await click(fixRow);
  await pause(900);
  cue("diff-1");
  const fileBox = await boxOf(fixRow.locator(".."));
  await focus(fileBox, 24);
  await pause(7000);

  await chapter("end");
  await focus("full");
  await pause(1000);
  mark("end", "done");
}

async function mainScene() {
  // 1. Import.
  await pause(1500);
  await chapter("import");
  await focus("full");
  await pause(1200);
  cue("import-1");
  await click(page.getByRole("button", { name: "Import repository" }));
  await pause(500);
  await focus(page.getByRole("dialog"), 40);
  await pause(1300);
  await click(
    page.getByRole("button", { name: /Use the demo repo|Tallyhub/ }).first(),
  );
  await fastForward("Importing", () =>
    page.waitForURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 3 * MINUTE }),
  );
  mark("project", page.url().split("/").pop());
  await focus("full");
  await pause(1200);
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  for (let i = 0; i < (await collapse.count()); i++) {
    const b = await collapse.nth(i).boundingBox();
    if (b && b.x < 400) {
      await click(collapse.nth(i));
      break;
    }
  }
  await pause(900);
  cue("import-2");
  await click(page.getByRole("button", { name: "Code layer" })).catch(() => {});
  await pause(3000);
  await click(page.getByRole("button", { name: "Code layer" })).catch(() => {});
  await pause(1200);

  // 2. Ask the agent.
  await chapter("ask");
  if (
    !(await page
      .locator('[contenteditable="true"], textarea')
      .last()
      .isVisible()
      .catch(() => false))
  ) {
    await click(page.getByRole("button", { name: "Toggle agent" }));
    await pause(900);
  }
  const panel = await agentPanel();
  await focus(
    panel.box
      ? [
          panel.box[0] - 20,
          panel.box[1] - 260,
          panel.box[2] + 40,
          panel.box[3] + 280,
        ]
      : "full",
  );
  await pause(600);
  cue("ask-1");
  await click(panel.composer);
  await panel.composer.pressSequentially(PROMPT, { delay: 22 });
  await pause(600);
  await page.keyboard.press("Enter");
  await pause(400);
  {
    const insp = await boxOf(inspector());
    await focus(insp ? [insp[0], 0, VIEW.width - insp[0], 520] : "full", 0);
  }
  await agentTurn("Agent planning");
  cue("ask-2");
  await pause(4500);
  await arrange();
  await zoomToward(["orgs", "users", "customers", "invoices"], 1);
  await focus(await tables(["orgs", "users", "customers", "invoices"]), 40);
  await pause(3500);

  // 3. Draw a relationship the agent left out.
  const orgs = (await page.locator('.react-flow__node[data-id="orgs"]').count())
    ? "orgs"
    : await page.evaluate(() =>
        [...document.querySelectorAll(".react-flow__node")]
          .map((n) => n.getAttribute("data-id"))
          .find((id) => /^(orgs|organizations|tenants)$/.test(id ?? "")),
      );
  if (!orgs) throw new Error("The agent's plan has no orgs table to draw to.");
  const fk = `${orgs.replace(/s$/, "")}_id`;
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
      !(await page
        .locator(`.react-flow__edge[data-id$=":${table}.${fk}"]`)
        .count())
    ) {
      from = table;
      break;
    }
  }
  if (!from) throw new Error("Every candidate table already points at orgs.");
  await chapter("draw");
  await fitView();
  await zoomToward([from, orgs], 1);
  await focus(await tables([from, orgs]), 60);
  await pause(800);
  cue("draw-1");
  const handle = async (table, side) => {
    const b = await boxOf(
      page
        .locator(
          `.react-flow__node[data-id="${table}"] .react-flow__handle-${side}`,
        )
        .first(),
    );
    return { x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 };
  };
  const source = await handle(from, "left");
  const target = await handle(orgs, "right");
  await moveTo(source.x, source.y);
  await pause(250);
  await page.mouse.down();
  await moveTo(
    (source.x + target.x) / 2,
    Math.min(source.y, target.y) - 50,
    600,
  );
  await moveTo(target.x, target.y, 600);
  await pause(300);
  await page.mouse.up();
  const edge = page
    .locator(`.react-flow__edge[data-id$=":${from}.${fk}"]`)
    .first();
  await edge.waitFor({ state: "attached", timeout: MINUTE });
  await pause(500);
  const toast = page.locator("[data-sonner-toast]").last();
  const toastBox = await boxOf(toast);
  await focus(
    toastBox ? union(toastBox, await tables([from, orgs])) : "full",
    40,
  );
  cue("draw-2");
  await pause(3500);
  await edge
    .locator("path")
    .last()
    .click({ force: true })
    .catch(() => {});
  await pause(600);
  {
    const insp = await boxOf(inspector());
    await focus(insp ? [insp[0], 0, insp[2], 460] : "full", 24);
  }
  await pause(3500);
  await page.keyboard.press("Escape").catch(() => {});

  // 4. Steer: reject and lock one of the agent's items, then re-plan.
  await chapter("steer");
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
  await pause(500);
  await focus(row, 90);
  await pause(700);
  cue("steer-1");
  await click(row.getByRole("button", { name: "Reject" }));
  await pause(1000);
  await click(row.getByRole("button", { name: "Lock" }));
  await pause(1300);
  const replan = page.getByRole("button", { name: "Re-plan" });
  await replan.scrollIntoViewIfNeeded();
  await focus(union(await boxOf(replan), await boxOf(row)), 60);
  await click(replan);
  cue("steer-2");
  {
    const p = await agentPanel();
    await focus(
      p.box ? [p.box[0] - 20, 0, VIEW.width - p.box[0] + 20, 620] : "full",
      0,
    );
  }
  await agentTurn("Agent re-planning");
  await pause(3500);

  // 5. Rehearse on a copy of the data.
  await chapter("rehearse");
  await focus("full");
  const rehearseButton = page.getByRole("button", {
    name: "Rehearse",
    exact: true,
  });
  if (await rehearseButton.isVisible().catch(() => false)) {
    await click(rehearseButton);
    await fastForward("Rehearsing", () =>
      page.waitForURL(/\/rehearse$/, { timeout: 5 * MINUTE }),
    );
  } else {
    await click(page.getByRole("link", { name: /Rehearse/ }).first());
    await page.waitForURL(/\/rehearse$/);
  }
  await pause(1200);
  cue("rehearse-1");
  const dataHeading = page.getByText("Data changes", { exact: false }).first();
  const replay = page.getByRole("button", { name: "Replay" });
  if (await replay.isVisible().catch(() => false)) {
    await replay.scrollIntoViewIfNeeded().catch(() => {});
    const h = await boxOf(dataHeading);
    await focus(h ? [h[0], h[1], VIEW.width - h[0] - 400, 420] : "full", 24);
    await pause(800);
    await click(replay);
    cue("rehearse-2");
    await pause(4500);
  }

  // 6. Conflicts: pick a fix for each.
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
    if (i === 0) await chapter("conflicts");
    await conflict.scrollIntoViewIfNeeded();
    await pause(400);
    await focus(conflict, 28);
    if (i === 0) cue("conflicts-1");
    await pause(2600);
    const values = await conflict
      .locator("input[type=radio]")
      .evaluateAll((els) => els.map((e) => e.value));
    const fix = preferred.find((p) => values.includes(p));
    if (!fix)
      throw new Error(
        `No fix without a value for this conflict: ${values.join(", ")}`,
      );
    await click(
      conflict.locator(`label:has(input[type=radio][value="${fix}"])`),
    );
    await pause(900);
    const heading = (
      await conflict.locator("header").first().innerText()
    ).trim();
    if (i === 0) cue("conflicts-2");
    await click(conflict.getByRole("button", { name: "Apply fix" }));
    const applying = page.getByRole("button", { name: "Applying…" });
    await applying
      .first()
      .waitFor({ state: "visible", timeout: 5 * SECOND })
      .catch(() => {});
    await fastForward("Re-running rehearsal", () =>
      applying.first().waitFor({ state: "hidden", timeout: 5 * MINUTE }),
    );
    await pause(1500);
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
    await click(again);
    await fastForward("Rehearsing", () =>
      page
        .getByRole("button", { name: "Rehearsing…" })
        .waitFor({ state: "hidden", timeout: 5 * MINUTE }),
    );
  }
  await page.mouse.wheel(0, -4000);
  await focus("full");
  await pause(2000);

  // 7. Tests, fixed by the agent.
  await chapter("tests");
  await click(page.getByRole("link", { name: /Ship/ }).first());
  await page.waitForURL(/\/ship$/);
  await pause(1500);
  const runTests = page.getByRole("button", { name: "Run tests" });
  const testsArea = async () =>
    union(
      await boxOf(runTests),
      await boxOf(page.getByText(/^Tests$/).first()),
    );
  await focus([0, 0, 1180, 664], 0);
  cue("tests-1");
  await click(runTests);
  const cancelRun = page.getByRole("button", { name: /Cancel run|Cancelling/ });
  const testsDone = () =>
    cancelRun.waitFor({ state: "hidden", timeout: 20 * MINUTE });
  await cancelRun
    .waitFor({ state: "visible", timeout: MINUTE })
    .catch(() => {});
  await fastForward("Running tests", testsDone);
  await pause(800);
  const results = async () => {
    const t = await boxOf(page.getByText(/passed in/).first());
    return t ? [t[0] - 20, t[1] - 40, 820, 480] : await testsArea();
  };
  await focus(await results(), 24);
  await pause(2800);
  for (let round = 0; round < 2; round++) {
    const fixButton = page
      .getByRole("button", { name: "Fix with agent" })
      .first();
    if (!(await fixButton.isVisible().catch(() => false))) break;
    if (round === 0) cue("tests-2");
    await click(fixButton);
    {
      const p = await agentPanel();
      await focus(
        p.box ? [p.box[0] - 20, 0, VIEW.width - p.box[0] + 20, 620] : "full",
        0,
      );
    }
    await agentTurn("Agent fixing the code");
    await fastForward("Running tests", testsDone);
    await pause(800);
    await focus(await results(), 24);
    cue("tests-3");
    await pause(3200);
  }

  // 8. Pull request.
  await chapter("pr");
  const repoInput = page.locator("#pr-repo");
  const createPr = page.getByRole("button", { name: "Create PR" });
  await focus(
    union(await boxOf(repoInput), await boxOf(createPr), await boxOf(runTests)),
    60,
  );
  await pause(600);
  cue("pr-1");
  if (PR_REPO) {
    await click(repoInput);
    await repoInput.fill("");
    await repoInput.pressSequentially(PR_REPO, { delay: 45 });
    await pause(600);
  }
  if (OPEN_PR) {
    await click(createPr);
    await fastForward("Opening pull request", () =>
      page
        .getByRole("link", { name: /View PR #\d+/ })
        .waitFor({ state: "visible", timeout: 5 * MINUTE }),
    );
    await pause(500);
    const opened = await boxOf(page.getByText(/PR #\d+ opened/).first());
    const prToast = await boxOf(page.locator("[data-sonner-toast]").last());
    await focus(union(opened, prToast) ?? "full", 60);
    cue("pr-2");
    await pause(4000);
  } else {
    mark("skip", "PR not opened (run with --pr to open it)");
    await moveTo(
      ...(await boxOf(createPr)).slice(0, 2).map((v, i) => v + (i ? 18 : 120)),
    );
    await pause(2500);
  }

  await chapter("end");
  await focus("full");
  await pause(1500);
  mark("end", "done");
}
