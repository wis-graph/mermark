// CDP Golden Master for the "sidebar strong-contrast, theme-inverted tone +
// dedicated foreground palette" design (_workspace/01_architect_design.md —
// SUPERSEDES the "은은한 recessed sidebar" design; that golden lived in
// scripts/sidebar-recessed-golden.mjs, now deleted).
//
// The .sidebar-aside shell (shared by explorer/outline/recent) paints
// --sidebar-bg/fg/muted/accent/border instead of --surface/--fg/--muted/
// --accent/--border. --sidebar-bg is a var(--bg)-anchored color-mix toward a
// per-theme pole, inverted per theme (dark: light pole, light/claude: dark
// pole — design decision 3), so the sidebar reads as a strong two-tone
// contrast against the editor canvas in every theme, and its own fixed
// --sidebar-fg/muted/accent stay legible against that pole regardless of
// what --bg a custom theme injects.
//
// Sweeps all 3 built-in themes (dark/light/claude, via the real
// `.theme-toggle` cycle — same production path a user takes, selection-
// golden.mjs's convention) and per theme:
//   (a) opens the outline aside via `.outline-btn` (toc-golden.mjs's pattern —
//       outline shares the `.sidebar-aside` shell/background with the
//       explorer, so this verifies the contract without needing a real
//       filesystem tree).
//   (b) reads getComputedStyle(...).backgroundColor for `.outline-aside` (the
//       sidebar shell) and `document.body` (the text-area canvas), plus
//       .color for the shell (--sidebar-fg) and `.sidebar-header` (--sidebar-
//       muted) — parses all of them (Chromium serializes color-mix() results
//       as `color(srgb r g b)`, plain hex canvases as `rgb(r, g, b)` — see
//       parseColor()).
//   (c) asserts isHighContrast(sidebarRgb, bodyRgb) (direction-agnostic
//       two-tone strength, contrast >= 7) AND the measured direction matches
//       expectedSidebarPolarity(theme) (the per-theme inversion contract).
//   (d) asserts sidebar foreground legibility: shell color (--sidebar-fg) vs
//       sidebar bg >= 7, sidebar-header color (--sidebar-muted) vs sidebar bg
//       >= 4.5 — both on an always-present surface (works even with
//       `.outline-empty`, no real file tree needed).
//   (e) saves a per-theme screenshot for the eyeball/tuning check.
//
// Then a 4th scenario: injects a custom JSON theme (no --sidebar-* key in the
// schema — it doesn't exist) via the real `mermark.themeJson` localStorage
// key, reloads, and asserts the sidebar foreground is STILL legible under an
// arbitrary custom bg — the var(--bg)-anchor zero-drift claim, machine-
// checked. Direction is NOT asserted for the custom scenario (design decision
// 2's documented residual limitation: a custom bg opposite the data-theme's
// own polarity may weaken direction/strength, but legibility always holds).
//
//   node scripts/sidebar-contrast-golden.mjs /tmp/sidebar-contrast.json
//
// Assumes `npm run dev:browser` + Chrome --remote-debugging-port=9222 running,
// and window.__mermark exposed (import.meta.env.DEV).
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "/tmp/sidebar-contrast.json";
const url = process.argv[3] ?? "http://localhost:1420/?file=x.md";
const shotBase = out.replace(/\.json$/, "");

const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.setViewportSize({ width: 1200, height: 900 });
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });

const hasHarness = await page.evaluate(() => !!window.__mermark);
if (!hasHarness) {
  console.error("window.__mermark missing — run `npm run dev:browser` (DEV build).");
  await browser.close();
  process.exit(2);
}

// Parses a computed color string into an [r,g,b] triple (0-255). Chromium
// serializes color-mix(in srgb, ...) results in the CSS Color 4 `color(srgb r
// g b [/ a])` form (components 0-1), while a plain hex canvas serializes as
// legacy `rgb(r, g, b)` (components 0-255) — this handles both.
function parseColor(str) {
  const colorFn = str.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (colorFn) {
    return [1, 2, 3].map((i) => parseFloat(colorFn[i]) * 255);
  }
  const rgbFn = str.match(/rgba?\(([^)]+)\)/);
  if (rgbFn) {
    const parts = rgbFn[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return [parts[0], parts[1], parts[2]];
  }
  throw new Error(`unparseable color: ${str}`);
}

// WCAG relative luminance (sRGB channels 0-255).
function relativeLuminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(rgbA, rgbB) {
  const lA = relativeLuminance(rgbA);
  const lB = relativeLuminance(rgbB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

// Direction-agnostic two-tone strength: does the sidebar read as a STRONG
// contrast band against the body canvas (either direction), not merely a
// recessed shade of the same tone?
//
// NOTE (design decision 3, revised 2026-07-12): dark no longer targets this
// invariant. Its sidebar is now deliberately a SUBTLE one-step-brighter dark
// (not a stark light-pole inversion — the prior #f9f7f3-pole sidebar next to a
// near-black canvas read as glare), so its measured two-tone contrast ratio
// legitimately drops well below 7. This is an ACCEPTED, intentional change,
// not a regression — see allThemesHighContrast below, which is expected to be
// false post-change (dark is the reason) while light/claude stay >=7.
function isHighContrast(sidebarRgb, bodyRgb) {
  return contrastRatio(sidebarRgb, bodyRgb) >= 7;
}

// The per-theme inversion DIRECTION contract (design decision 3): dark's
// sidebar stays the LIGHTER pole relative to its own (near-black) canvas —
// unchanged by the 2026-07-12 repolarization, which only pulled the pole's
// ABSOLUTE lightness down (from #f9f7f3 to #211d1a) so the two are close in
// the same dark family instead of a stark inversion. light/claude keep the
// DARK pole against their bright canvas.
const EXPECTED_SIDEBAR_POLARITY = { dark: "sidebar-lighter", light: "sidebar-darker", claude: "sidebar-darker" };
function expectedSidebarPolarity(theme) {
  return EXPECTED_SIDEBAR_POLARITY[theme] ?? null;
}
function measuredSidebarPolarity(sidebarRgb, bodyRgb) {
  return relativeLuminance(sidebarRgb) > relativeLuminance(bodyRgb) ? "sidebar-lighter" : "sidebar-darker";
}

/** Open the outline aside via its footer button (toc-golden.mjs's pattern —
 *  outline shares .sidebar-aside's shell/background with the explorer, so this
 *  reaches the contrast contract with zero filesystem dependency). */
async function openOutline() {
  await page.evaluate(() => {
    const btn = document.querySelector(".outline-btn");
    const aside = document.querySelector(".outline-aside");
    if (aside && aside.hidden) btn?.click();
  });
  await page
    .waitForFunction(() => {
      const aside = document.querySelector(".outline-aside");
      return aside && !aside.hidden;
    }, { timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(150);
}

async function readSidebarState(label) {
  const raw = await page.evaluate(() => {
    const aside = document.querySelector(".outline-aside");
    const header = document.querySelector(".sidebar-header");
    return {
      dataTheme: document.documentElement.dataset.theme ?? null,
      sidebar: aside ? getComputedStyle(aside).backgroundColor : null,
      sidebarFg: aside ? getComputedStyle(aside).color : null,
      sidebarMuted: header ? getComputedStyle(header).color : null,
      body: getComputedStyle(document.body).backgroundColor,
      asideFound: !!aside,
      asideHidden: aside ? aside.hidden : null,
    };
  });
  const sidebarRgb = parseColor(raw.sidebar);
  const bodyRgb = parseColor(raw.body);
  const sidebarFgRgb = parseColor(raw.sidebarFg);
  const sidebarMutedRgb = raw.sidebarMuted ? parseColor(raw.sidebarMuted) : null;
  const twoToneRatio = contrastRatio(sidebarRgb, bodyRgb);
  const fgLegibility = contrastRatio(sidebarFgRgb, sidebarRgb);
  const mutedLegibility = sidebarMutedRgb ? contrastRatio(sidebarMutedRgb, sidebarRgb) : null;
  const shotPath = `${shotBase}.${raw.dataTheme ?? label}.png`;
  await page.screenshot({ path: shotPath });
  return {
    label,
    dataTheme: raw.dataTheme,
    asideFound: raw.asideFound,
    asideHidden: raw.asideHidden,
    sidebarBackgroundColor: raw.sidebar,
    bodyBackgroundColor: raw.body,
    sidebarRgb,
    bodyRgb,
    twoToneContrastRatio: twoToneRatio,
    isHighContrast: isHighContrast(sidebarRgb, bodyRgb),
    measuredPolarity: measuredSidebarPolarity(sidebarRgb, bodyRgb),
    expectedPolarity: expectedSidebarPolarity(raw.dataTheme),
    polarityMatches: raw.dataTheme
      ? measuredSidebarPolarity(sidebarRgb, bodyRgb) === expectedSidebarPolarity(raw.dataTheme)
      : null,
    sidebarFgLegibility: fgLegibility,
    sidebarFgLegible: fgLegibility >= 7,
    sidebarMutedLegibility: mutedLegibility,
    sidebarMutedLegible: mutedLegibility === null ? null : mutedLegibility >= 4.5,
    screenshot: shotPath,
  };
}

// --- Scenario 1: 3 built-in themes, real path (deterministic start) ---
await page.evaluate(() => localStorage.clear());
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForFunction(() => !!window.__mermark, { timeout: 8000 });
await page.waitForTimeout(500);
await openOutline();

// Cycle `.theme-toggle` (dark -> light -> claude -> dark, settings/app.ts's
// nextPreset order) rather than poking localStorage directly — loadPreset()
// writes themeSetting + themeJsonSetting together, the only way to reach a
// fully coherent theme state (selection-golden.mjs's convention).
const themeStates = [];
const seenThemes = new Set();
let guard = 0;
while (seenThemes.size < 3 && guard < 6) {
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  if (theme && !seenThemes.has(theme)) {
    seenThemes.add(theme);
    themeStates.push(await readSidebarState(`theme=${theme}`));
  }
  await page.click(".theme-toggle");
  await page.waitForTimeout(400);
  await openOutline(); // theme toggle does not close the aside, but re-assert it's open
  guard++;
}

// --- Scenario 2: custom theme zero-drift (no --sidebar-* key in the schema) ---
// A bg the built-in presets never use, with the other 7 core keys filled with
// arbitrary-but-valid values, injected via the real `mermark.themeJson` sink
// key (settings/app.ts). Asserts the CSS var(--bg) anchor alone (no dedicated
// sidebar setting) keeps the sidebar foreground LEGIBLE under a bg the
// schema/CSS authors never saw — direction is not asserted here (design
// decision 2's documented residual limitation).
const CUSTOM_THEME = {
  name: "custom-zero-drift-check",
  colors: {
    bg: "#223344",
    fg: "#eef2f7",
    accent: "#88aadd",
    link: "#88aadd",
    surface: "#334455",
    border: "rgba(255,255,255,.12)",
    muted: "#9fb3c8",
    highlightBg: "#ffe066",
  },
  radii: { md: "8px", lg: "12px", xl: "16px" },
  font: { sans: "Inter, sans-serif" },
};

await page.evaluate((theme) => {
  localStorage.setItem("mermark.themeJson", JSON.stringify(theme));
  // themeSetting.parse expects the bare preset string (no JSON quoting) —
  // pins data-theme="dark" so the dark ratio (8%, the tightest weight) is the
  // one under test; themeJsonSetting's --bg inline override is what actually
  // matters for the zero-drift claim (the ratio only ever comes from CSS).
  localStorage.setItem("mermark.theme", "dark");
}, CUSTOM_THEME);
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForFunction(() => !!window.__mermark, { timeout: 8000 });
await page.waitForTimeout(500);
await openOutline();
const customState = await readSidebarState("custom-theme");

const result = {
  themeStates,
  customState,
  allThemesHighContrast: themeStates.every((s) => s.isHighContrast),
  allThemesPolarityMatches: themeStates.every((s) => s.polarityMatches),
  allThemesFgLegible: themeStates.every((s) => s.sidebarFgLegible),
  allThemesMutedLegible: themeStates.every((s) => s.sidebarMutedLegible),
  customThemeFgLegible: customState.sidebarFgLegible,
  errors,
};

writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log("\nwrote", out);
await browser.close();
