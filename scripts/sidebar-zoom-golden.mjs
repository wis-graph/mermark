// CDP Golden Master for "탐색기(사이드바) 텍스트를 ⌘±(--font-scale) 줌에 통합"
// (_workspace/01_architect_design.md, _workspace/01_architect_plan.md step 4).
//
// The vitest style-contract (tests/sidebar-zoom.test.ts) proves the CSS TEXT is
// correct (right selectors, right em fractions, scale=1 arithmetic parity).
// This golden proves the LIVE DOM agrees when the REAL persisted SSOT path is
// exercised end-to-end: mermark.fontScale in localStorage -> fontScaleSetting
// .parse -> clampFontScale -> applyFontScale (theme.ts) -> --font-scale CSS var
// -> .sidebar-aside's calc(13px * var(--font-scale, 1)) -> computed font-size.
// Deliberately does NOT poke `--font-scale` directly via JS — that would only
// prove the CSS calc works, not that the setting's persistence/parse/sink path
// actually drives it (the thing a real ⌘± keypress or a restored session uses).
//
// Skeleton cloned from scripts/sidebar-contrast-golden.mjs (CDP :9222 connect,
// window.__mermark check, .outline-btn to open the outline aside, computed-style
// read, screenshot, JSON report).
//
//   node scripts/sidebar-zoom-golden.mjs /tmp/sidebar-zoom.json
//
// Assumes `npm run dev:browser` + Chrome --remote-debugging-port=9222 running,
// and window.__mermark exposed (import.meta.env.DEV).
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { assertPageRendered } from "./lib/preflight.mjs";

const out = process.argv[2] ?? "/tmp/sidebar-zoom.json";
// Audit 04 (2026-07-11, 🔴 1): the default x.md target has no directory in the
// mock's list_dir TREE (src/mocks/tauri-core.ts), so the explorer tree never
// grows a folder row and `.explorer-star` never mounts — the ORIGINAL version
// of this golden could only ever reach `.explorer-chevron` (a <span>, not a
// <button>), so it silently never exercised the 4 button-hosted glyphs the
// audit flagged (G4/G5/G7/G8). /mock/vault/index.md's dir (/mock/vault) has a
// real "notes" child folder in that TREE, so opening the explorer here always
// mounts a `.explorer-star` on that row.
const url = process.argv[3] ?? "http://localhost:1430/?file=/mock/vault/index.md";
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

/** Open the EXPLORER aside via its footer button (not the outline — audit 04
 *  🔴 1 found that the original outline-only path never exercised the 4
 *  <button>-hosted glyphs, `.explorer-star`/`.favorites-remove`, because
 *  neither mounts inside the outline aside. The explorer aside shares the
 *  same `.sidebar-aside`/`.sidebar-header` shell classes, so switching to it
 *  keeps the shell/header measurements identical while also giving us the
 *  folder-row star and the favorites section (hosted inside the SAME
 *  `.explorer-aside`, see explorer-panel.ts's favoritesSlot). */
async function openExplorer() {
  await page.evaluate(() => {
    const btn = document.querySelector(".explorer-btn");
    const aside = document.querySelector(".explorer-aside");
    if (aside && aside.hidden) btn?.click();
  });
  await page
    .waitForFunction(() => {
      const aside = document.querySelector(".explorer-aside");
      return aside && !aside.hidden;
    }, { timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(150);
}

/** Reads the computed sizes the design's zoom contract makes claims about:
 *  the sidebar shell (root calc), .sidebar-header (11/13 em child), the
 *  editor's .cm-line (the "1:1 통합" claim — sidebar and editor scale the
 *  SAME --font-scale together), .explorer-chevron (span glyph, the control
 *  group that always tracked zoom correctly), and — audit 04 🔴 1's permanent
 *  regression guard — the two <button>-hosted glyphs that silently ignored
 *  zoom before `font: inherit` was added: `.explorer-star`/its `.icon`, and
 *  `.favorites-remove`/its `.icon`. The url points at /mock/vault/index.md
 *  (a dir with a real "notes" child in the mock's list_dir TREE) and
 *  localStorage seeds one favorite folder before navigation, so both
 *  elements are guaranteed to be mounted, not best-effort. */
async function readZoomState(label) {
  const raw = await page.evaluate(() => {
    const aside = document.querySelector(".explorer-aside");
    const header = document.querySelector(".sidebar-header");
    // Skip heading lines (.cm-heading) — they carry their own relative em
    // size on top of the base, so the first .cm-line in a doc can easily be
    // an h1 and give a false "editor didn't scale 1:1" reading. A plain body
    // line is the base --editor-font-size * --font-scale with nothing else
    // riding on top.
    const cmLine = document.querySelector(".cm-line:not(.cm-heading)");
    const chevron = document.querySelector(".explorer-chevron");
    const star = document.querySelector(".explorer-star");
    const starIcon = document.querySelector(".explorer-star .icon");
    const remove = document.querySelector(".favorites-remove");
    const removeIcon = document.querySelector(".favorites-remove .icon");
    return {
      fontScaleVar: getComputedStyle(document.documentElement).getPropertyValue("--font-scale").trim(),
      shellFontSize: aside ? getComputedStyle(aside).fontSize : null,
      headerFontSize: header ? getComputedStyle(header).fontSize : null,
      cmLineFontSize: cmLine ? getComputedStyle(cmLine).fontSize : null,
      chevronWidth: chevron ? getComputedStyle(chevron).width : null,
      // G4/G5/G7/G8 (audit 04 🔴 1): before the fix these were UA-button-font
      // fixed values (~20.5/13.328/18.453/12.297px) at BOTH scales — same
      // number scale=1 and scale=1.5. After the fix they must equal the
      // .explorer-chevron/.sidebar-aside pattern: scale with --font-scale.
      explorerStarWidth: star ? getComputedStyle(star).width : null,
      explorerStarIconWidth: starIcon ? getComputedStyle(starIcon).width : null,
      favoritesRemoveWidth: remove ? getComputedStyle(remove).width : null,
      favoritesRemoveIconWidth: removeIcon ? getComputedStyle(removeIcon).width : null,
      asideFound: !!aside,
      asideHidden: aside ? aside.hidden : null,
      starFound: !!star,
      removeFound: !!remove,
    };
  });
  const shotPath = `${shotBase}.${label}.png`;
  await page.screenshot({ path: shotPath });
  return { label, ...raw, screenshot: shotPath };
}

function px(str) {
  if (str == null) return null;
  const n = Number.parseFloat(str);
  return Number.isFinite(n) ? n : null;
}

function within(actual, expected, tolerance = 0.1) {
  return actual != null && Math.abs(actual - expected) <= tolerance;
}

// --- Scenario 1: scale=1 (no --font-scale set / applied at default) ---
// Also seeds ONE favorite folder (the real persisted SSOT path — same
// favoriteFoldersSetting.parse JSON shape the app itself writes via
// pushFavorite/removeFavorite — not a live-DOM click) so `.favorites-remove`
// is GUARANTEED mounted below, not a best-effort null (audit 04 🔴 1: the
// original golden never exercised this element at all).
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem("mermark.favoriteFolders", JSON.stringify(["/mock/vault/notes"]));
});
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
const hasHarness = await page.evaluate(() => !!window.__mermark);
if (!hasHarness) {
  console.error("window.__mermark missing — run `npm run dev:browser` (DEV build).");
  await browser.close();
  process.exit(2);
}
await page.waitForTimeout(500);
// Refuse to measure a page that never rendered — see scripts/lib/preflight.mjs.
// Once here (just before the first real measurement) is enough: every
// subsequent goto in this script reloads the SAME already-verified bundle.
await assertPageRendered(page, { context: "sidebar-zoom-golden" });
await openExplorer();
const before = await readZoomState("scale-1.0");

// --- Mutual-exclusion e2e check (R9, _workspace/01_architecture.md) ---
// The unit tests (tests/sidebar-panels.test.ts) already prove
// closeOtherSidebarPanels closes fake panels; this is the only CDP-level
// evidence that the real DOM/CSS assembly main.ts wires through
// registerSidebarPanel/installSidebarPanels still enforces "at most one left
// rail open at a time" after R9's rewrite. Opens outline (must close the
// explorer scenario 1 just opened), confirms it landed open ALONE, then
// re-opens explorer (must close outline) and confirms outline went hidden —
// the actual regression signal. Ends with explorer open again, so scenario 2
// below is unaffected.
async function checkMutualExclusion() {
  await page.evaluate(() => {
    document.querySelector(".outline-btn")?.click();
  });
  await page
    .waitForFunction(() => {
      const aside = document.querySelector(".outline-aside");
      return aside && !aside.hidden;
    }, { timeout: 4000 })
    .catch(() => {});
  const outlineOpenedAlone = await page.evaluate(() => {
    const outline = document.querySelector(".outline-aside");
    const explorer = document.querySelector(".explorer-aside");
    return !!outline && !outline.hidden && !!explorer && explorer.hidden;
  });

  await openExplorer(); // only clicks if .explorer-aside is currently hidden — true here since outline just took the rail
  const outlineClosedAfterExplorerOpen = await page.evaluate(() => {
    const outline = document.querySelector(".outline-aside");
    return !!outline && outline.hidden;
  });

  return {
    outlineOpenedAlone,
    outlineClosedAfterExplorerOpen,
    mutualExclusionHolds: outlineOpenedAlone && outlineClosedAfterExplorerOpen,
  };
}
const mutualExclusion = await checkMutualExclusion();

// --- Scenario 2: mermark.fontScale=1.5 via the REAL persisted SSOT path ---
// (fontScaleSetting.parse -> clampFontScale -> applyFontScale on boot, main.ts)
await page.evaluate(() => localStorage.setItem("mermark.fontScale", "1.5"));
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForFunction(() => !!window.__mermark, { timeout: 8000 });
await page.waitForTimeout(500);
await openExplorer();
const after = await readZoomState("scale-1.5");

// --- Teardown: clear the settings + reload so this golden never leaks state
// into a subsequent golden run (sidebar-contrast-golden.mjs's convention). ---
await page.evaluate(() => {
  localStorage.removeItem("mermark.fontScale");
  localStorage.removeItem("mermark.favoriteFolders");
});
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForFunction(() => !!window.__mermark, { timeout: 8000 });
await page.waitForTimeout(300);
await openExplorer();
const teardown = await readZoomState("teardown-restored");

const beforeShell = px(before.shellFontSize);
const beforeHeader = px(before.headerFontSize);
const afterShell = px(after.shellFontSize);
const afterHeader = px(after.headerFontSize);
const afterCmLine = px(after.cmLineFontSize);
const teardownShell = px(teardown.shellFontSize);

// audit 04 🔴 1 permanent regression guard: .explorer-star / .favorites-remove
// (and their .icon children) MUST scale with --font-scale exactly like
// .explorer-chevron/.sidebar-aside do. Before the `font: inherit` fix these
// were UA-button-font fixed values — IDENTICAL at scale=1 and scale=1.5
// (20.5/13.328/18.453/12.297px both times) — so the strongest single proof
// this golden can carry is "before != after" alongside the exact px math.
const beforeStar = px(before.explorerStarWidth);
const beforeStarIcon = px(before.explorerStarIconWidth);
const afterStar = px(after.explorerStarWidth);
const afterStarIcon = px(after.explorerStarIconWidth);
const beforeRemove = px(before.favoritesRemoveWidth);
const beforeRemoveIcon = px(before.favoritesRemoveIconWidth);
const afterRemove = px(after.favoritesRemoveWidth);
const afterRemoveIcon = px(after.favoritesRemoveIconWidth);

const result = {
  before,
  after,
  teardown,
  mutualExclusion,
  // scale=1 baseline: pixel-identical to the pre-feature fixed values.
  beforeShellIs13px: within(beforeShell, 13, 0.05),
  beforeHeaderIs11px: within(beforeHeader, 11, 0.05),
  // scale=1.5: shell 13*1.5=19.5, header 11*1.5=16.5 (design 확정 3, 1:1 ratio).
  afterShellIs19_5px: within(afterShell, 19.5),
  afterHeaderIs16_5px: within(afterHeader, 16.5),
  // "1:1 통합" claim: the editor's .cm-line is ALSO 16*1.5=24px at the same
  // scale — sidebar and editor track the one --font-scale SSOT together.
  afterCmLineIs24px: within(afterCmLine, 24),
  // teardown: removing the key restores default (1.0) -> shell back to 13px.
  teardownRestoredTo13px: within(teardownShell, 13, 0.05),
  // G4/G5/G7/G8 mounted at all (audit 04's original gap: never queried).
  glyphsMounted: !!before.starFound && !!before.removeFound && !!after.starFound && !!after.removeFound,
  // scale=1 pixel identity (unchanged post-fix — the design's other invariant).
  beforeExplorerStarIs20px: within(beforeStar, 20, 0.1),
  beforeExplorerStarIconIs13px: within(beforeStarIcon, 13, 0.1),
  beforeFavoritesRemoveIs18px: within(beforeRemove, 18, 0.1),
  beforeFavoritesRemoveIconIs12px: within(beforeRemoveIcon, 12, 0.1),
  // scale=1.5: 20/18/13/12 * 1.5 = 30/27/19.5/18 — the fix's whole point.
  afterExplorerStarIs30px: within(afterStar, 30, 0.15),
  afterExplorerStarIconIs19_5px: within(afterStarIcon, 19.5, 0.15),
  afterFavoritesRemoveIs27px: within(afterRemove, 27, 0.15),
  afterFavoritesRemoveIconIs18px: within(afterRemoveIcon, 18, 0.15),
  // The regression this golden exists to catch: before the fix these 4 were
  // IDENTICAL at both scales (UA button font, --font-scale-blind).
  explorerStarRespondsToZoom: beforeStar != null && afterStar != null && beforeStar !== afterStar,
  favoritesRemoveRespondsToZoom: beforeRemove != null && afterRemove != null && beforeRemove !== afterRemove,
  errors,
};
result.allPass =
  result.beforeShellIs13px &&
  result.beforeHeaderIs11px &&
  result.afterShellIs19_5px &&
  result.afterHeaderIs16_5px &&
  result.afterCmLineIs24px &&
  result.teardownRestoredTo13px &&
  result.glyphsMounted &&
  result.beforeExplorerStarIs20px &&
  result.beforeExplorerStarIconIs13px &&
  result.beforeFavoritesRemoveIs18px &&
  result.beforeFavoritesRemoveIconIs12px &&
  result.afterExplorerStarIs30px &&
  result.afterExplorerStarIconIs19_5px &&
  result.afterFavoritesRemoveIs27px &&
  result.afterFavoritesRemoveIconIs18px &&
  result.explorerStarRespondsToZoom &&
  result.favoritesRemoveRespondsToZoom &&
  result.mutualExclusion.mutualExclusionHolds &&
  errors.length === 0;

writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log("\nwrote", out);
await browser.close();
process.exit(result.allPass ? 0 : 1);
