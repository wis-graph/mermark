// CDP Golden Master for the selection-permeability CSS fix: in-line surface
// backgrounds (.cm-code-line / .cm-callout / .cm-inline-code) must stay
// translucent so CM's .cm-selectionBackground overlay (z-index -1, the only
// selection paint inside .cm-line — see styles.css's SELECTION PERMEABILITY
// RULE) shows through when a drag/vim-visual selection crosses them.
//
// Sweeps all 3 themes (dark/light/claude, via the real `.theme-toggle` cycle
// so themeSetting + themeJsonSetting stay coherent — the same production path
// a user takes, not a hand-poked localStorage key) and per theme:
//   (a) asserts computed backgroundColor alpha < 1 for the three selectors
//       (Chromium serializes the color-mix() result as `color(srgb r g b / a)`,
//       so alphaOf() reads the slash-alpha directly — see its comment).
//   (b) sets a real EditorState selection that crosses the fenced code block
//       and asserts .cm-selectionBackground rects geometrically intersect a
//       .cm-code-line rect (the "selection paints THROUGH the code line, not
//       under it" claim, machine-checked).
//   (c) saves a screenshot per theme for the eyeball check (panel identity +
//       visible selection tint — the alpha tuning judgment call from the
//       design doc lives here, not in an assertion).
//
//   node scripts/selection-golden.mjs /tmp/selection-after.json
//
// Assumes `npm run dev:browser` + Chrome --remote-debugging-port=9222 running,
// and window.__mermark exposed (import.meta.env.DEV — see main.ts / the
// existing nav-trace.mjs convention this script borrows its rig from).
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { assertPageRendered } from "./lib/preflight.mjs";

const out = process.argv[2] ?? "/tmp/selection-golden.json";
const url = process.argv[3] ?? "http://localhost:1430/?file=x.md";
const shotBase = out.replace(/\.json$/, "");

// CDP port is overridable (env `CDP_PORT`, default 9222) so a run can target a
// FRESH browser: a long-lived shared automation Chrome degrades after renderer
// crashes and starts producing infra failures that mimic product regressions
// (2026-07-20).
const CDP_PORT = process.env.CDP_PORT ?? "9222";
const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.setViewportSize({ width: 1200, height: 900 });
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
// deterministic start: clear persisted prefs (theme/mode/etc.), reload to
// system default — same convention as settings-golden.mjs.
await page.evaluate(() => localStorage.clear());
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(1500);

// Refuse to measure a page that never rendered — see scripts/lib/preflight.mjs.
await assertPageRendered(page, { context: "selection-golden" });

// A small fixture doc that puts all three "surface veil" selectors on screen
// at once: an inline-code span, a `[!note]` callout, and a fenced code block.
// Replaces the SAMPLE doc's content via a real EditorState dispatch (ground
// truth, not DOM typing) — the nav-trace.mjs convention.
const FIXTURE = [
  "# Selection permeability fixture",
  "",
  "Some `inline code` span for testing.",
  "",
  "> [!note] Callout",
  "> callout body line",
  "",
  "```ts",
  "function example() {",
  "  return 42;",
  "}",
  "```",
  "",
].join("\n");

await page.evaluate((text) => {
  const C = window.__mermark;
  if (!C) throw new Error("window.__mermark missing — is import.meta.env.DEV true?");
  C.setMode("edit");
  const len = C.view.state.doc.length;
  C.view.dispatch({ changes: { from: 0, to: len, insert: text } });
}, FIXTURE);
await page.waitForTimeout(300);

// Reveal the fenced code block (cm-code-line only renders as real DOM lines
// while the block is revealed for editing — see code-block.ts's codeLines
// InlineFeature comment) by putting the caret inside its body, then set a
// selection that CROSSES the block boundary (anchor on the blank line before
// the fence, head inside the body) so the crossing-selection claim is real.
await page.evaluate(() => {
  const C = window.__mermark;
  const doc = C.view.state.doc;
  const lineNum = (needle) => {
    for (let n = 1; n <= doc.lines; n++) if (doc.line(n).text.includes(needle)) return n;
    return -1;
  };
  const beforeFence = doc.line(lineNum("```ts") - 1).from; // blank line above the fence
  const insideBody = doc.line(lineNum("return 42")).to; // inside the fenced body
  C.view.focus();
  C.view.dispatch({ selection: { anchor: beforeFence, head: insideBody } });
});
await page.waitForTimeout(150);

function alphaOf(colorStr) {
  if (!colorStr) return 1;
  // Modern slash-alpha syntax: "color(srgb r g b / a)", "rgb(r g b / a)".
  // Chrome serializes color-mix() backgrounds this way (not legacy rgba()).
  const slash = colorStr.match(/\/\s*([0-9.]+%?)\s*\)/);
  if (slash) {
    const v = slash[1];
    return v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
  }
  // Legacy comma syntax: "rgba(r, g, b, a)". Bare rgb()/keywords → opaque (1).
  const m = colorStr.match(/rgba?\(([^)]+)\)/);
  if (!m) return 1;
  const parts = m[1].split(",").map((s) => s.trim());
  return parts.length === 4 ? parseFloat(parts[3]) : 1;
}

function rectsIntersect(a, b) {
  const yOverlap = a.top < b.bottom && b.top < a.bottom;
  return yOverlap && a.width > 0 && b.width > 0 && a.height > 0 && b.height > 0;
}

const snap = (label) =>
  page.evaluate((label) => {
    function alphaOfBg(selector) {
      const el = document.querySelector(selector);
      if (!el) return { selector, found: false, alpha: null };
      const bg = getComputedStyle(el).backgroundColor;
      return { selector, found: true, backgroundColor: bg };
    }
    const codeLineRects = [...document.querySelectorAll(".cm-code-line")].map((el) =>
      el.getBoundingClientRect(),
    );
    const selectionRects = [...document.querySelectorAll(".cm-selectionBackground")].map((el) =>
      el.getBoundingClientRect(),
    );
    return {
      label,
      dataTheme: document.documentElement.dataset.theme ?? null,
      backgrounds: [
        alphaOfBg(".cm-code-line"),
        alphaOfBg(".cm-callout"),
        alphaOfBg(".cm-inline-code"),
      ],
      codeLineRectCount: codeLineRects.length,
      selectionRectCount: selectionRects.length,
      codeLineRects: codeLineRects.map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height })),
      selectionRects: selectionRects.map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height })),
    };
  }, label);

async function evaluateSnap(label) {
  const raw = await snap(label);
  const backgrounds = raw.backgrounds.map((b) => ({
    ...b,
    alpha: b.found ? alphaOf(b.backgroundColor) : null,
  }));
  const intersects = raw.codeLineRects.some((cl) =>
    raw.selectionRects.some((sel) => rectsIntersect(cl, sel)),
  );
  const shotPath = `${shotBase}.${raw.dataTheme ?? label}.png`;
  await page.screenshot({ path: shotPath });
  return {
    label,
    dataTheme: raw.dataTheme,
    backgrounds,
    allAlphasBelow1: backgrounds.every((b) => b.found && b.alpha !== null && b.alpha < 1),
    codeLineRectCount: raw.codeLineRectCount,
    selectionRectCount: raw.selectionRectCount,
    selectionIntersectsCodeLine: intersects,
    screenshot: shotPath,
  };
}

// Cycle `.theme-toggle` (dark -> light -> claude -> dark, nextPreset's real
// order — settings/app.ts) rather than poking localStorage keys directly:
// loadPreset() writes themeSetting + themeJsonSetting together, so this is
// the only way to reach a fully coherent theme state (SSOT — see
// syncJsonToPreset's comment on why a bare themeSetting write can desync).
const states = [];
const seenThemes = new Set();
let guard = 0;
while (seenThemes.size < 3 && guard < 6) {
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  if (theme && !seenThemes.has(theme)) {
    seenThemes.add(theme);
    states.push(await evaluateSnap(`theme=${theme}`));
  }
  await page.click(".theme-toggle");
  await page.waitForTimeout(600); // theme re-bake (+ any mermaid re-render, none in this fixture)
  guard++;
}

const result = {
  states,
  allThemesAlphaBelow1: states.every((s) => s.allAlphasBelow1),
  allThemesSelectionCrossesCodeLine: states.every((s) => s.selectionIntersectsCodeLine),
  errors,
};

writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log("\nwrote", out);
await browser.close();
