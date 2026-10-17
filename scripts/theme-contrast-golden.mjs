// CDP golden for the D1 theme-parity AA pass (2026-10-18, _workspace_design/
// 01_architect_design.md §2). tests/theme-contrast.test.ts proves the contrast
// of the *declared* tokens from styles.css TEXT; this script proves the same
// pairs against REAL computed values in a real browser — the cascade /
// specificity / inline-JSON-sink mistakes a text-only gate cannot see.
//
// Scenarios (all via the real production paths):
//   1. localStorage cleared -> 11-callout demo doc injected via
//      window.__mockExternalChange -> `.theme-toggle` cycles dark/light/claude;
//      per theme: every `.cm-callout-<t>.cm-callout-head` >= 4.5 on its tint,
//      `.status-pos` (muted) >= 4.5, claude `.cm-inline-code` >= 4.5; Settings
//      is opened and the active segment text, an inactive segment, and
//      `.settings-text-help` are each >= 4.5.
//   2. Old saved preset: `mermark.themeJson` = the pre-AA light preset (with
//      `comment`, muted #777169) -> reload -> computed --muted is #6f6a63
//      (retired-preset snap); a ONE-character custom variant keeps its value.
//   3. Custom light theme (name "custom", bg #fffdf7, fg #202020) while
//      data-theme stays dark: warning/tip heads >= 4.5 (the derived-token
//      principle: no per-theme callout table to fall out of sync).
//
//   node scripts/theme-contrast-golden.mjs /tmp/theme-contrast.json
//
// Assumes `npm run dev:browser` (:1430) + Chrome --remote-debugging-port=9222
// (CDP_PORT overrides). NOT YET RUN by the author — qa-verifier executes it and
// stores the table as _workspace_design/03_metrics_after.txt.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { assertPageRendered } from "./lib/preflight.mjs";

const out = process.argv[2] ?? "/tmp/theme-contrast.json";
const url = process.argv[3] ?? "http://localhost:1430/?file=/mock/vault/index.md";
const CDP_PORT = process.env.CDP_PORT ?? "9222";
const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

const TYPES = ["note", "abstract", "info", "todo", "tip", "success", "question", "warning", "failure", "danger", "bug", "example"];
// `note` / `quote` opt out of the derived hue on purpose (neutral): measured, but
// they are --fg / --muted and are covered by the muted checks.
const DEMO = TYPES.map((t) => `> [!${t}] ${t} 제목\n> 본문 ${t}\n`).join("\n") + "\n\n`인라인 코드` 와 본문\n";

// ---- colour math (computed styles: rgb(), rgba() or color(srgb r g b / a)) ----
function parseColor(str) {
  const fn = str.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/);
  if (fn) return [fn[1], fn[2], fn[3]].map((v) => parseFloat(v) * 255).concat(fn[4] === undefined ? 1 : parseFloat(fn[4]));
  const rgb = str.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const p = rgb[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
  }
  throw new Error(`unparseable colour: ${str}`);
}
const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
const lum = ([r, g, b]) => {
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a, b) => {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** Contrast of a (possibly translucent) foreground over the layers beneath it. */
const contrastOver = (fg, ...layersTopToBottom) => {
  let under = layersTopToBottom.map(parseColor).reduceRight((acc, c) => over(c, acc), [255, 255, 255, 1]);
  return ratio(over(parseColor(fg), under), under);
};

async function boot(storage = {}) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  await page.evaluate((s) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  }, storage);
  await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForFunction(() => !!window.__mermark, { timeout: 8000 });
  await page.waitForTimeout(400);
}
async function injectDemo() {
  await page.evaluate((t) => window.__mockExternalChange?.(t), DEMO);
  await page.waitForSelector(".cm-callout-head", { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(300);
}

/** Computed head colour of every callout type + the layers it sits on. */
const readCallouts = () =>
  page.evaluate((types) => {
    const body = getComputedStyle(document.body).backgroundColor;
    return types.map((t) => {
      const el = document.querySelector(`.cm-callout-${t}.cm-callout-head`);
      const row = document.querySelector(`.cm-callout-${t}`);
      return {
        type: t,
        found: !!el,
        color: el ? getComputedStyle(el).color : null,
        tint: row ? getComputedStyle(row).backgroundColor : null,
        body,
      };
    });
  }, TYPES);

function minCalloutRatio(rows, skip = ["note"]) {
  let min = Infinity, which = null;
  for (const r of rows) {
    if (!r.found || skip.includes(r.type)) continue;
    const c = contrastOver(r.color, r.tint, r.body);
    if (c < min) { min = c; which = r.type; }
  }
  return { min, which, missing: rows.filter((r) => !r.found && !skip.includes(r.type)).map((r) => r.type) };
}

// ---------------- scenario 1: three built-in themes ----------------
await boot();
await assertPageRendered(page, { context: "theme-contrast-golden" });
const result = { themes: {}, snap: {}, custom: {}, errors };
const seen = new Set();
for (let guard = 0; seen.size < 3 && guard < 6; guard++) {
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  if (theme && !seen.has(theme)) {
    seen.add(theme);
    await injectDemo();
    const rows = await readCallouts();
    const callouts = minCalloutRatio(rows);
    const probes = await page.evaluate(() => {
      const c = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).color : null; };
      return {
        bg: getComputedStyle(document.body).backgroundColor,
        statusPos: c(".status-pos"),
        inlineCode: c(".cm-inline-code"),
        inlineCodeBg: (() => { const e = document.querySelector(".cm-inline-code"); return e ? getComputedStyle(e).backgroundColor : null; })(),
      };
    });
    const t = { callouts, statusPos: probes.statusPos ? contrastOver(probes.statusPos, probes.bg) : null };
    if (theme === "claude" && probes.inlineCode) t.inlineCode = contrastOver(probes.inlineCode, probes.inlineCodeBg, probes.bg);

    // Settings: active / inactive segment + help text, on the modal surface.
    await page.click(".settings-btn");
    await page.waitForTimeout(250);
    const cats = await page.$$(".settings-cat");
    let seg = null;
    let helpFg = null;
    for (const cat of cats) {
      await cat.click();
      await page.waitForTimeout(120);
      const segHere = await page.evaluate(() => {
        const on = document.querySelector(".settings-seg-btn[aria-pressed=true]");
        if (!on) return null;
        const off = [...document.querySelectorAll(".settings-seg-btn")].find((b) => b.getAttribute("aria-pressed") !== "true");
        const help = document.querySelector(".settings-text-help");
        const surface = getComputedStyle(document.querySelector(".settings-modal, .settings-panel, .settings-pane") ?? document.body).backgroundColor;
        const g = (e) => (e ? getComputedStyle(e) : null);
        return {
          onFg: g(on).color, onBg: g(on).backgroundColor,
          offFg: off ? g(off).color : null,
          helpFg: help ? g(help).color : null,
          surface,
          body: getComputedStyle(document.body).backgroundColor,
        };
      });
      if (!seg) seg = segHere;
      // help text lives in a different category than the segments: collect it separately
      if (!helpFg) {
        helpFg = await page.evaluate(() => {
          const h = document.querySelector(".settings-text-help");
          return h ? getComputedStyle(h).color : null;
        });
      }
      if (seg && helpFg) break;
    }
    if (seg) {
      seg.helpFg = helpFg;
      t.activeSegment = contrastOver(seg.onFg, seg.onBg);
      if (seg.offFg) t.inactiveSegment = contrastOver(seg.offFg, seg.surface, seg.body);
      if (seg.helpFg) t.settingsHelp = contrastOver(seg.helpFg, seg.surface, seg.body);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    result.themes[theme] = t;
  }
  await page.click(".theme-toggle");
  await page.waitForTimeout(400);
}

// ---------------- scenario 2: retired-preset snap ----------------
// The preset's font/radii are not asserted by hand here: take them from a real
// preset write (theme toggle -> light) so only muted/h6 differ from the live preset.
await boot();
// Cycle until the LIGHT preset is live (the start theme depends on the browser's
// prefers-color-scheme, so a single toggle is not reliably "-> light").
for (let g = 0; g < 4; g++) {
  await page.click(".theme-toggle");
  await page.waitForTimeout(400);
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) === "light") break;
}
const livePreset = await page.evaluate(() => JSON.parse(localStorage.getItem("mermark.themeJson") ?? "null"));
const oldSnapshot = JSON.parse(JSON.stringify(livePreset));
oldSnapshot.colors.muted = "#777169";
oldSnapshot.colors.h6 = "#777169";
const custom1 = JSON.parse(JSON.stringify(oldSnapshot));
custom1.colors.muted = "#777168"; // one character off -> customised, must survive
const readMuted = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--muted").trim());
await boot({ "mermark.theme": "light", "mermark.themeJson": JSON.stringify(oldSnapshot) });
result.snap.oldPresetMuted = await readMuted();
await boot({ "mermark.theme": "light", "mermark.themeJson": JSON.stringify(custom1) });
result.snap.customMuted = await readMuted();

// ---------------- scenario 3: custom bright theme under data-theme=dark ----------------
const customBright = JSON.parse(JSON.stringify(livePreset));
customBright.name = "custom";
Object.assign(customBright.colors, { bg: "#fffdf7", fg: "#202020", surface: "#ffffff" });
await boot({ "mermark.theme": "dark", "mermark.themeJson": JSON.stringify(customBright) });
await injectDemo();
const customRows = await readCallouts();
result.custom.dataTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
result.custom.callouts = minCalloutRatio(customRows);
for (const t of ["warning", "tip"]) {
  const r = customRows.find((x) => x.type === t);
  result.custom[t] = r?.found ? contrastOver(r.color, r.tint, r.body) : null;
}

// ---------------- verdict ----------------
const AA = 4.5;
const checks = [];
const ok = (name, v, min = AA) => checks.push({ name, value: v, pass: typeof v === "number" && v >= min });
for (const [theme, t] of Object.entries(result.themes)) {
  ok(`${theme} callout heads (min of 11, ${t.callouts.which})`, t.callouts.min);
  if (t.callouts.missing.length) checks.push({ name: `${theme} callouts missing`, value: t.callouts.missing.join(","), pass: false });
  ok(`${theme} .status-pos`, t.statusPos);
  if (theme === "claude") ok("claude inline code", t.inlineCode);
  ok(`${theme} active segment`, t.activeSegment);
  ok(`${theme} inactive segment`, t.inactiveSegment);
  ok(`${theme} settings help`, t.settingsHelp);
}
checks.push({ name: "themes visited", value: Object.keys(result.themes).join(","), pass: Object.keys(result.themes).length === 3 });
checks.push({ name: "old light preset snaps to #6f6a63", value: result.snap.oldPresetMuted, pass: result.snap.oldPresetMuted.toLowerCase() === "#6f6a63" });
checks.push({ name: "one-char custom keeps #777168", value: result.snap.customMuted, pass: result.snap.customMuted.toLowerCase() === "#777168" });
ok("custom bright theme: warning head", result.custom.warning);
ok("custom bright theme: tip head", result.custom.tip);
checks.push({ name: "no page errors", value: errors.length, pass: errors.length === 0 });

console.log("\n| check | value | pass |\n|---|---|---|");
for (const c of checks) console.log(`| ${c.name} | ${typeof c.value === "number" ? c.value.toFixed(2) : c.value} | ${c.pass ? "PASS" : "FAIL"} |`);
const pass = checks.every((c) => c.pass);
result.checks = checks;
writeFileSync(out, JSON.stringify(result, null, 2));
console.log("\nwrote", out);
console.log(pass ? "\n✓ theme-contrast-golden PASS" : "\n✗ theme-contrast-golden FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
