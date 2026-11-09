// Turns raw takes from record-4k.mjs into a product video: the app framed on a
// plain backdrop, a few deliberate zooms, title cards, captions, and an
// AssemblyAI voiceover. Every frame is drawn by render.html in Chrome.
//
// Sections, fast-forwards, camera moves, and voiceover timing come from the
// takes' markers.json files, so a new take needs no hand-tuned timestamps.
// Zooms are opt-in per section (edl.json "zoom"), so the default is the wide shot.
//
// Usage:
//   node scripts/demo-edit/edit.mjs --take=DIR [--extra=tour:DIR,features:DIR] --assemblyai-env=PATH/.env.local
//   node scripts/demo-edit/edit.mjs ... --stills=12,40,95   # preview frames only
//   node scripts/demo-edit/edit.mjs ... --mix-only           # redo audio on OUT/video.mp4
// Flags: --edl=PATH (default edl.json here), --out=DIR (default TAKE/edit),
//   --voice=aai-michael, --playwright=PATH, --chrome=PATH.
// The env file must hold ASSEMBLYAI_API_KEY=...; the key only goes to
// AssemblyAI's TTS endpoint and is never printed.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flag = (name, fallback = "") =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;

const TAKE = flag("take");
if (!TAKE) throw new Error("--take=DIR is required");
const OUT = flag("out", path.join(TAKE, "edit"));
const EDL = JSON.parse(
  fs.readFileSync(flag("edl", path.join(here, "edl.json")), "utf8"),
);
const VOICE = flag("voice", EDL.voice ?? "aai-michael");
const FPS = EDL.fps ?? 30;
const CUE_STILLS = process.argv.includes("--cue-stills");
const STILLS = flag("stills").split(",").filter(Boolean).map(Number);
const require = createRequire(import.meta.url);
const { chromium } = require(
  flag("playwright", "/usr/lib/node_modules/playwright-core"),
);
const CHROME = flag("chrome", "/usr/bin/google-chrome-stable");
const FONT = path.join(
  here,
  "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
);

fs.mkdirSync(path.join(OUT, "tts"), { recursive: true });

// ---- media ---------------------------------------------------------------------

const probeDuration = (file) =>
  Number(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      file,
    ])
      .toString()
      .trim(),
  );

// Takes are appended in order into one proxy; each take's markers shift by its offset.
const TAKES = [
  { name: "main", dir: TAKE },
  ...flag("extra")
    .split(",")
    .filter(Boolean)
    .map((spec) => {
      const [name, ...rest] = spec.split(":");
      return { name, dir: rest.join(":") };
    }),
];
let offset = 0;
for (const take of TAKES) {
  take.offset = offset;
  take.length = probeDuration(path.join(take.dir, "raw.mp4"));
  offset += take.length;
}
const takeOf = (name) => {
  const take = TAKES.find((t) => t.name === name);
  if (!take)
    throw new Error(
      `No take named "${name}"; pass it with --extra=${name}:DIR`,
    );
  return take;
};
const MARKERS = TAKES.flatMap((take) =>
  JSON.parse(fs.readFileSync(path.join(take.dir, "markers.json"), "utf8")).map(
    (m) => ({ ...m, t: m.t + take.offset, take: take.name }),
  ),
);

function proxy() {
  // One seek-friendly file with every take, keyframes every 10 frames.
  const key = crypto
    .createHash("sha256")
    .update(TAKES.map((t) => `${t.name}:${t.dir}:${t.length}`).join("|"))
    .digest("hex")
    .slice(0, 10);
  const file = path.join(OUT, `proxy-${key}.mp4`);
  if (!fs.existsSync(file)) {
    console.log("Encoding seek-friendly proxy…");
    const inputs = TAKES.map((t) => path.join(t.dir, "raw.mp4"));
    const graph = `${inputs.map((_, i) => `[${i}:v]fps=30,setpts=PTS-STARTPTS[v${i}]`).join(";")};${inputs.map((_, i) => `[v${i}]`).join("")}concat=n=${inputs.length}:v=1:a=0[out]`;
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      ...inputs.flatMap((f) => ["-i", f]),
      "-filter_complex",
      graph,
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "14",
      "-g",
      "10",
      "-pix_fmt",
      "yuv420p",
      "-an",
      file,
    ]);
  }
  return file;
}

function assemblyKey() {
  const envPath = flag("assemblyai-env");
  if (!envPath)
    throw new Error("--assemblyai-env=PATH is required for the voiceover");
  const key = fs
    .readFileSync(envPath, "utf8")
    .match(/^ASSEMBLYAI_API_KEY=(.+)$/m)?.[1]
    ?.trim();
  if (!key) throw new Error(`No ASSEMBLYAI_API_KEY in ${envPath}`);
  return key;
}

async function speak(text) {
  const hash = crypto
    .createHash("sha256")
    .update(`${VOICE}|${text}`)
    .digest("hex")
    .slice(0, 16);
  const file = path.join(OUT, "tts", `${hash}.mp3`);
  if (!fs.existsSync(file)) {
    const res = await fetch("https://tts.us.assemblyai.com/v1/speech", {
      method: "POST",
      headers: {
        Authorization: assemblyKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice_id: VOICE,
        language: "english",
        encoding: "mp3",
        stream: false,
      }),
    });
    if (!res.ok)
      throw new Error(
        `TTS failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return { file, duration: probeDuration(file) };
}

// ---- geometry --------------------------------------------------------------------

const VIEW = { w: 1536, h: 864 };
const FRAMED = (() => {
  const w = VIEW.w / 0.92;
  return { x: -(w - VIEW.w) / 2, y: -((w * 9) / 16 - VIEW.h) / 2, w };
})();
const MIN_W = 1000; // gentle zooms only
const MOVE = 1.2; // seconds a camera move takes
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeInOut = (x) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** A focus box (CSS px) to a 16:9 camera rect that stays inside the window. */
function fit(rect, pad) {
  if (!rect) return FRAMED;
  const [x, y, w, h] = rect;
  const cw = Math.max(w + 2 * pad, ((h + 2 * pad) * 16) / 9, MIN_W);
  if (cw >= VIEW.w * 0.94) return FRAMED;
  const ch = (cw * 9) / 16;
  const cx = Math.min(Math.max(x + w / 2, cw / 2), VIEW.w - cw / 2);
  const cy = Math.min(Math.max(y + h / 2, ch / 2), VIEW.h - ch / 2);
  return { x: cx - cw / 2, y: cy - ch / 2, w: cw };
}

function lerpRect(a, b, t) {
  const e = easeInOut(clamp01(t));
  const w = Math.exp(Math.log(a.w) * (1 - e) + Math.log(b.w) * e);
  const ca = { x: a.x + a.w / 2, y: a.y + (a.w * 9) / 32 };
  const cb = { x: b.x + b.w / 2, y: b.y + (b.w * 9) / 32 };
  return {
    x: ca.x + (cb.x - ca.x) * e - w / 2,
    y: ca.y + (cb.y - ca.y) * e - (w * 9) / 32,
    w,
  };
}

/** Camera at source time t: holds each key, easing into the next. */
function camera(keys, t) {
  if (t <= keys[0].at) return keys[0].r;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.at) {
      const span = Math.min(MOVE, b.at - a.at);
      return t < b.at - span
        ? a.r
        : lerpRect(a.r, b.r, (t - (b.at - span)) / span);
    }
  }
  return keys[keys.length - 1].r;
}

// ---- timeline --------------------------------------------------------------------

const FF_SECONDS = 1.4;
const VO_START = 0.3;
const LEAD = 0.6; // narration starts this long before the action it describes
const VO_TAIL = 0.6;
const FADE = 0.45; // footage fade in/out next to title cards
const XFADE = 0.6; // crossfade where footage jumps

function captionChunks(text, duration) {
  const parts = text
    .match(/[^.,;:!?]+[.,;:!?]?/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [];
  for (const part of parts) {
    const words = part.split(/\s+/);
    for (let i = 0; i < words.length; i += 9) {
      const c = words.slice(i, i + 9).join(" ");
      if (merged.length && `${merged.at(-1)} ${c}`.split(/\s+/).length <= 9)
        merged[merged.length - 1] += ` ${c}`;
      else merged.push(c);
    }
  }
  const total = merged.reduce((n, c) => n + c.length, 0);
  let at = 0;
  return merged.map((c) => {
    const d = (c.length / total) * duration;
    const chunk = { text: c, from: at, to: at + d };
    at += d;
    return chunk;
  });
}

function sectionRange(s) {
  const take = takeOf(s.take ?? "main");
  if (s.range)
    return { from: take.offset + s.range[0], to: take.offset + s.range[1] };
  const chapter = s.chapter ?? s.id;
  const chapters = MARKERS.filter(
    (m) => m.kind === "chapter" && m.take === take.name,
  );
  const i = chapters.findIndex((m) => m.label === chapter);
  if (i < 0)
    throw new Error(
      `The ${take.name} take has no "${chapter}" chapter marker.`,
    );
  // "until" extends the section through later chapters, up to the named one.
  const untilIndex = s.until
    ? chapters.findIndex((m) => m.label === s.until)
    : i + 1;
  const end = chapters[untilIndex]?.t ?? take.offset + take.length;
  const [skipStart, skipEnd] = s.trim ?? [0, 0];
  return { from: chapters[i].t + skipStart, to: end - skipEnd };
}

function segmentsFor({ from, to }, pace = 1) {
  const segments = [];
  let cursor = from;
  let at = 0;
  const push = (a, b, ff) => {
    if (b - a < 1 / FPS) return;
    const speed = ff ? (b - a) / FF_SECONDS : pace;
    segments.push({ from: a, to: b, speed, ff, at, length: (b - a) / speed });
    at += (b - a) / speed;
  };
  for (let i = 0; i < MARKERS.length; i++) {
    const s = MARKERS[i];
    if (s.kind !== "ff-start" || s.t < from || s.t >= to) continue;
    const e = MARKERS.slice(i + 1).find(
      (m) => m.kind === "ff-end" && m.label === s.label,
    );
    if (!e) continue;
    push(cursor, s.t, false);
    push(s.t, Math.min(e.t, to), e.t - s.t > FF_SECONDS * 1.5);
    cursor = Math.min(e.t, to);
  }
  push(cursor, to, false);
  return { segments, footage: at };
}

const localOf = (segments, src) => {
  const seg =
    segments.find((g) => src >= g.from && src <= g.to) ?? segments.at(-1);
  return (
    seg.at + (Math.min(Math.max(src, seg.from), seg.to) - seg.from) / seg.speed
  );
};
const srcAt = (s, local) => {
  const t = Math.min(local, s.footage - 1 / FPS);
  const seg =
    s.segments.find((g) => t >= g.at && t < g.at + g.length) ??
    s.segments.at(-1);
  return {
    seg,
    src: Math.min(
      seg.from + (Math.min(t, seg.at + seg.length) - seg.at) * seg.speed,
      seg.to - 1 / FPS,
    ),
  };
};

/** Camera keys for a section: the wide shot, plus only the zooms the EDL asks for. */
function cameraKeys(s, range, startRect) {
  const take = s.take ?? "main";
  const boxes = MARKERS.filter(
    (m) =>
      m.kind === "focus" &&
      m.label === "box" &&
      m.take === take &&
      m.t >= range.from - 0.01 &&
      m.t < range.to,
  );
  const keys = [
    { at: range.from, r: s.camStart ? fit(s.camStart, 24) : startRect },
  ];
  for (const z of s.zoom ?? []) {
    // { rect: [x, y, w, h], after: seconds into the section, hold? } zooms to an explicit area.
    if (z && !Array.isArray(z) && typeof z === "object") {
      const at = range.from + z.after;
      keys.push({ at, r: fit(z.rect, 0) });
      if (z.hold != null) keys.push({ at: at + z.hold + MOVE, r: FRAMED });
      continue;
    }
    const [index, hold] = Array.isArray(z) ? z : [z, null];
    const m = boxes[index];
    if (!m) continue;
    const at = m.t + 0.6;
    keys.push({ at, r: fit(m.rect, m.pad ?? 32) });
    if (hold != null) keys.push({ at: at + hold + MOVE, r: FRAMED });
  }
  if (!s.zoom?.length && !s.camStart && startRect !== FRAMED)
    keys.push({ at: range.from + MOVE, r: FRAMED });
  return keys.sort((a, b) => a.at - b.at);
}

async function buildTimeline() {
  const sections = [];
  let start = 0;
  for (const [index, s] of EDL.sections.entries()) {
    if (s.card) {
      const audio = s.vo ? await speak(s.vo) : null;
      const duration = audio
        ? Math.max(3.2, VO_START + audio.duration + VO_TAIL + 0.4)
        : (s.duration ?? 3.5);
      const items = (s.card.items ?? []).map(
        (_, i, all) =>
          VO_START +
          0.4 +
          ((audio?.duration ?? duration - 1) * 0.85 * i) / all.length,
      );
      const cues = audio
        ? [{ at: VO_START, text: s.vo, ...audio, captions: [] }]
        : [];
      sections.push({ ...s, start, duration, itemTimes: items, cues });
      start += duration;
      continue;
    }
    const range = sectionRange(s);
    const lines =
      typeof s.vo === "string" ? [[null, s.vo]] : Object.entries(s.vo ?? {});
    const audios = [];
    const textOf = (v) => (Array.isArray(v) ? v[0] : v);
    for (const [, v] of lines) audios.push(await speak(textOf(v)));
    // Pace the footage to the narration: speed it up (never slow it down) so the
    // shot lasts about as long as what is said over it, instead of idling.
    const base = segmentsFor(range, 1);
    const ffLength = base.segments
      .filter((g) => g.ff)
      .reduce((n, g) => n + g.length, 0);
    const normalLength = base.footage - ffLength;
    const spoken = audios.reduce((n, a) => n + a.duration + 0.3, 0);
    const target = Math.max(spoken + 0.6, 2.5) - ffLength;
    const pace =
      s.speed ??
      Math.min(
        Math.max(normalLength / Math.max(target, 1), 1),
        EDL.maxSpeed ?? 2,
      );
    const { segments, footage } = segmentsFor(range, pace);
    const previous = sections.at(-1);
    const continuous =
      previous?.range && Math.abs(previous.range.to - range.from) < 0.05;
    const startRect = continuous ? previous.keys.at(-1).r : FRAMED;
    const keys = cameraKeys(s, range, startRect);
    const cues = [];
    let free = VO_START;
    // A plain string plays from the section start; an object maps cue markers to lines.
    // Each line starts just before its moment, so it is said while it happens.
    for (const [lineIndex, [id, value]] of lines.entries()) {
      const text = textOf(value);
      const shift = Array.isArray(value) ? value[1] : 0;
      let local = 0;
      if (id) {
        const marker = MARKERS.find(
          (m) =>
            m.kind === "cue" && m.label === id && m.take === (s.take ?? "main"),
        );
        if (!marker) continue;
        local = localOf(segments, marker.t);
      }
      const audio = audios[lineIndex];
      const at = Math.max(local - LEAD + shift, free);
      cues.push({
        at,
        text,
        ...audio,
        captions: captionChunks(text, audio.duration),
      });
      free = at + audio.duration + 0.25;
    }
    const beforeCard = EDL.sections[index + 1]?.card;
    // voFlows: the voiceover may run on into the following sections (used by the cold open).
    const voEnd = s.voFlows ? 0 : free - 0.25 + VO_TAIL;
    const duration = Math.max(footage + (beforeCard ? FADE : 0), voEnd);
    sections.push({
      ...s,
      start,
      duration,
      footage,
      segments,
      keys,
      cues,
      range,
      continuous,
      crossfade: previous?.range && !continuous,
    });
    start += duration;
  }
  const allCues = sections.flatMap((s) =>
    s.cues.map((c) => ({ ...c, at: s.start + c.at })),
  );
  return { sections, total: start, allCues };
}

function footageState(s, local) {
  const { seg, src } = srcAt(s, local);
  return { seg, src, cam: camera(s.keys, src) };
}

function frameState(timeline, T) {
  const s =
    timeline.sections.find((x) => T >= x.start && T < x.start + x.duration) ??
    timeline.sections.at(-1);
  const local = T - s.start;
  const state = {
    src: null,
    cam: FRAMED,
    winOpacity: 0,
    winBlur: 0,
    under: null,
    card: null,
    chip: null,
    cap: null,
    ff: null,
  };
  for (const cue of timeline.allCues) {
    const v = T - cue.at;
    const c = cue.captions.find((x) => v >= x.from && v < x.to + 0.15);
    if (c) state.cap = { text: c.text, o: clamp01((v - c.from) / 0.15) };
  }
  if (s.card) {
    const shown = (s.itemTimes ?? []).map((at) => clamp01((local - at) / 0.5));
    state.card = {
      id: s.id,
      p: local / 1.1,
      out: clamp01((local - (s.duration - 0.45)) / 0.45),
      items: shown,
    };
    state.cap = null;
    return state;
  }
  const index = timeline.sections.indexOf(s);
  const { seg, src, cam } = footageState(s, local);
  state.src = src;
  state.cam = cam;
  const fadeIn =
    timeline.sections[index - 1]?.card || index === 0
      ? clamp01(local / FADE)
      : 1;
  const fadeOut = timeline.sections[index + 1]?.card
    ? clamp01((s.duration - local) / FADE)
    : 1;
  state.winOpacity = Math.min(easeInOut(fadeIn), easeInOut(fadeOut));
  state.winBlur = (1 - Math.min(fadeIn, fadeOut)) * 12;
  // Jumping between takes or skipping ahead: dissolve from the previous section's last frame.
  if (s.crossfade && local < XFADE) {
    const prev = timeline.sections[index - 1];
    const last = footageState(prev, prev.duration);
    state.under = { src: last.src, cam: last.cam };
    state.mix = easeInOut(local / XFADE);
  }
  if (s.label) {
    const prev = timeline.sections[index - 1];
    const chipIn = prev?.label ? 1 : clamp01((local - 0.15) / 0.35);
    state.chip = { n: s.pillar ?? "", text: s.label, o: chipIn };
  }
  if (local < s.footage && seg.ff) {
    const into = (local - seg.at) / seg.length;
    state.ff = {
      text: `Sped up ${Math.round(seg.speed)}×`,
      o: Math.min(clamp01(into / 0.15), clamp01((1 - into) / 0.15)),
    };
  }
  return state;
}

// ---- render ------------------------------------------------------------------------

const timeline = await buildTimeline();
console.log(`Timeline: ${timeline.total.toFixed(1)}s`);
for (const s of timeline.sections) {
  const voice = s.cues.reduce((n, c) => n + c.duration, 0);
  console.log(
    `  ${s.start.toFixed(1).padStart(6)}s  ${s.id.padEnd(10)} ${s.duration.toFixed(1)}s  (voice ${voice.toFixed(1)}s)`,
  );
}

const videoOnly = path.join(OUT, "video.mp4");
const MIX_ONLY =
  process.argv.includes("--mix-only") && fs.existsSync(videoOnly);
if (!MIX_ONLY) await render();

async function render() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(path.join(here, "render.html")).href);
  await page.evaluate((arg) => window.setup(arg), {
    videoUrl: pathToFileURL(proxy()).href,
    fontUrl: pathToFileURL(FONT).href,
    cardDefs: timeline.sections
      .filter((s) => s.card)
      .map((s) => ({ id: s.id, ...s.card })),
  });

  if (CUE_STILLS) {
    // One frame from the middle of every spoken line, for checking narration against picture.
    for (const [i, cue] of timeline.allCues.entries()) {
      const T = cue.at + cue.duration * 0.6;
      await page.evaluate(
        (st) => window.renderFrame(st),
        frameState(timeline, T),
      );
      const file = path.join(OUT, `cue-${String(i).padStart(2, "0")}.jpg`);
      await page.screenshot({ path: file, type: "jpeg", quality: 85 });
      console.log(`${file}  ${T.toFixed(1)}s  ${cue.text}`);
    }
    await browser.close();
    process.exit(0);
  }

  if (STILLS.length) {
    for (const T of STILLS) {
      await page.evaluate(
        (st) => window.renderFrame(st),
        frameState(timeline, T),
      );
      const file = path.join(OUT, `still-${String(T).replace(".", "_")}.jpg`);
      await page.screenshot({ path: file, type: "jpeg", quality: 90 });
      console.log(file);
    }
    await browser.close();
    process.exit(0);
  }

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
      "slow",
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      videoOnly,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const encoded = new Promise((resolve, reject) =>
    encoder.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
    ),
  );
  const frames = Math.ceil(timeline.total * FPS);
  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    await page.evaluate(
      (st) => window.renderFrame(st),
      frameState(timeline, i / FPS + 1 / (2 * FPS)),
    );
    const jpeg = await page.screenshot({ type: "jpeg", quality: 94 });
    if (!encoder.stdin.write(jpeg))
      await new Promise((r) => encoder.stdin.once("drain", r));
    if (i % 300 === 0)
      console.log(
        `frame ${i}/${frames}  ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
  }
  encoder.stdin.end();
  await encoded;
  await browser.close();
}

// ---- voiceover mix -------------------------------------------------------------------

const cues = timeline.allCues;
const inputs = cues.flatMap((c) => ["-i", c.file]);
const filters = cues.map((c, i) => {
  const ms = Math.round(c.at * 1000);
  return `[${i + 1}:a]aresample=48000,adelay=${ms}|${ms}[a${i}]`;
});
const mix = `${filters.join(";")};${cues.map((_, i) => `[a${i}]`).join("")}amix=inputs=${cues.length}:normalize=0,apad,atrim=0:${timeline.total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`;
const finalPath = path.join(OUT, "blueprint-demo.mp4");
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-i",
    videoOnly,
    ...inputs,
    "-filter_complex",
    mix,
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    finalPath,
  ],
  { stdio: "inherit" },
);
console.log(`\nDone: ${finalPath} (${timeline.total.toFixed(1)}s)`);
