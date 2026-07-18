// CDP Golden Master for "뷰어(이미지·Excel) 텍스트를 ⌘±(--font-scale) 줌에
// 통합" (04_audit_report.md 재호출 4차). Mirrors scripts/sidebar-zoom-golden.mjs's
// shape exactly — same reason: the vitest style-contract
// (tests/viewer-zoom.test.ts) proves the CSS TEXT is correct; this proves the
// LIVE DOM agrees when the REAL persisted SSOT path is exercised end-to-end:
// mermark.fontScale in localStorage -> fontScaleSetting.parse -> clampFontScale
// -> applyFontScale (theme.ts) -> --font-scale CSS var -> .viewer-panel's
// calc(13px * var(--font-scale, 1)) -> computed font-size. Deliberately does
// NOT poke `--font-scale` directly via JS — that would only prove the CSS calc
// works, not that the setting's persistence/parse/sink path actually drives it.
//
// STAGE 6 REVIEW (full-pane rewrite, _workspace/01_architect_design.md/
// 01_architect_plan.md §Stage 6, 2026-07-18) — qa-verifier read this file
// against the new source (styles.css's "VIEWER ZOOM RULE" / "VIEWER-LOCAL
// ZOOM" anchor comment above `.viewer-panel`, and excel-viewer/index.ts's
// injected CSS) before touching it, per the plan's explicit instruction to
// check whether this golden's contract had inverted. CONCLUSION: this
// file's assertions are NOT inverted and needed NO changes. The VIEWER ZOOM
// RULE (⌘± scales CHROME TEXT, INCLUDING `.excel-viewer-table`'s em-fraction
// font-size, via the SAME 13px-base cascade `.viewer-panel-caption` and
// `.excel-viewer-tab` use) is explicitly "kept unchanged by the full-pane
// rewrite" per that comment — it is a DIFFERENT, ADDITIONAL axis from the
// new `--viewer-zoom` (design §B "VIEWER-LOCAL ZOOM", the header [-]/[+]
// buttons), not a replacement of it. What DID invert this round is
// html-viewer's iframe content (its OWN sink moved from `fontScale.bind` to
// `shell.zoom.bind` — see html-viewer/index.ts's diff) — but this file never
// exercised html-viewer, so that inversion has no referent here either; it
// is covered instead by tests/html-viewer.test.ts's adversarial pair and by
// scripts/viewer-golden.mjs's new G18 (zoom independence). The one addition
// below (`viewerZoomVar...Unchanged1_0`) is a small supplementary check,
// added here rather than invented as a new assertion elsewhere, confirming
// empirically — in the SAME two fontScale states this file already visits —
// that `--viewer-zoom` (the shell's OWN axis) stays untouched by fontScale,
// i.e. the two axes are orthogonal, not that one replaced the other.
//
//   node scripts/viewer-zoom-golden.mjs /tmp/viewer-zoom.json
//
// Requires: `npm run dev:browser` + Chrome --remote-debugging-port=9222,
// mock-assets/mock/vault/report.xlsx present (scripts/lib/make-excel-fixture.mjs).
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { assertPageRendered } from "./lib/preflight.mjs";

const out = process.argv[2] ?? "/tmp/viewer-zoom.json";
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

await page.setViewportSize({ width: 1280, height: 900 });

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

async function openExcelViewer() {
  await openExplorer();
  await page.locator('.explorer-item[data-path="/mock/vault/report.xlsx"]').click();
  await page.waitForTimeout(700); // fetch bytes + dynamic import("xlsx") + parse
}

/** Reads the computed sizes the VIEWER ZOOM RULE (styles.css anchor comment
 *  above `.viewer-panel`) makes claims about: the panel root calc, an
 *  extension's OWN injected-CSS leaf sizes (`.excel-viewer-tab` — a
 *  <button>, the one that would silently ignore zoom without `font: inherit`
 *  — `.excel-viewer-table`, `.excel-viewer-caption`), and the built-in image
 *  viewer's caption (same shared `.viewer-panel-caption` class, proving the
 *  built-in viewer isn't a special case). */
async function readZoomState(label) {
  const raw = await page.evaluate(() => {
    const panel = document.querySelector(".excel-viewer");
    const tab = document.querySelector(".excel-viewer-tab");
    const table = document.querySelector(".excel-viewer-table");
    const caption = document.querySelector(".excel-viewer-caption");
    return {
      fontScaleVar: getComputedStyle(document.documentElement).getPropertyValue("--font-scale").trim(),
      // Stage 6 addition — the shell's OWN axis (design §B "VIEWER-LOCAL
      // ZOOM"), read straight off the pane root's inline style the same way
      // shell.ts's makeZoomController writes it. A fresh open() always
      // starts at 1 (ZOOM_DEFAULT, shell.ts) regardless of fontScale — this
      // is the orthogonality check, not a zoom-ladder exercise (that's
      // scripts/viewer-golden.mjs's G17/G18).
      viewerZoomVar: panel ? panel.style.getPropertyValue("--viewer-zoom") : null,
      panelFontSize: panel ? getComputedStyle(panel).fontSize : null,
      tabFontSize: tab ? getComputedStyle(tab).fontSize : null,
      tableFontSize: table ? getComputedStyle(table).fontSize : null,
      captionFontSize: caption ? getComputedStyle(caption).fontSize : null,
      panelFound: !!panel,
      tabFound: !!tab,
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

// --- Scenario 1: scale=1 (no --font-scale set) ---
await page.evaluate(() => localStorage.clear());
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
const hasHarness = await page.evaluate(() => !!window.__mermark);
if (!hasHarness) {
  console.error("window.__mermark missing — run `npm run dev:browser` (DEV build).");
  await browser.close();
  process.exit(2);
}
await page.waitForTimeout(500);
await assertPageRendered(page, { context: "viewer-zoom-golden" });
await openExcelViewer();
const before = await readZoomState("scale-1.0");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

// --- Scenario 2: mermark.fontScale=1.5 via the REAL persisted SSOT path ---
await page.evaluate(() => localStorage.setItem("mermark.fontScale", "1.5"));
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForFunction(() => !!window.__mermark, { timeout: 8000 });
await page.waitForTimeout(500);
await openExcelViewer();
const after = await readZoomState("scale-1.5");

// --- Teardown: clear the setting + reload so this golden never leaks state
// into a subsequent golden run (sidebar-zoom-golden.mjs's convention). ---
await page.evaluate(() => localStorage.removeItem("mermark.fontScale"));
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForFunction(() => !!window.__mermark, { timeout: 8000 });
await page.waitForTimeout(300);
await openExcelViewer();
const teardown = await readZoomState("teardown-restored");
await page.keyboard.press("Escape");

const beforePanel = px(before.panelFontSize);
const beforeTab = px(before.tabFontSize);
const beforeTable = px(before.tableFontSize);
const beforeCaption = px(before.captionFontSize);
const afterPanel = px(after.panelFontSize);
const afterTab = px(after.tabFontSize);
const afterTable = px(after.tableFontSize);
const afterCaption = px(after.captionFontSize);
const teardownPanel = px(teardown.panelFontSize);

const result = {
  before,
  after,
  teardown,
  // scale=1 baseline: pixel-identical to the pre-feature fixed values
  // (12.5/13 em fraction math, design's whole reason for that shape).
  beforePanelIs13px: within(beforePanel, 13, 0.05),
  beforeTabIs12_5px: within(beforeTab, 12.5, 0.05),
  beforeTableIs12_5px: within(beforeTable, 12.5, 0.05),
  beforeCaptionIs12_5px: within(beforeCaption, 12.5, 0.05),
  // scale=1.5: panel 13*1.5=19.5, leaves 12.5*1.5=18.75.
  afterPanelIs19_5px: within(afterPanel, 19.5),
  afterTabIs18_75px: within(afterTab, 18.75),
  afterTableIs18_75px: within(afterTable, 18.75),
  afterCaptionIs18_75px: within(afterCaption, 18.75),
  // teardown: removing the key restores default (1.0).
  teardownRestoredTo13px: within(teardownPanel, 13, 0.05),
  // The regression this golden exists to catch: BEFORE the font:inherit fix
  // (or before the extension had any zoom integration at all), the tab
  // <button> would sit at a fixed UA font-size — IDENTICAL at both scales.
  panelRespondsToZoom: beforePanel != null && afterPanel != null && beforePanel !== afterPanel,
  tabRespondsToZoom: beforeTab != null && afterTab != null && beforeTab !== afterTab,
  tableRespondsToZoom: beforeTable != null && afterTable != null && beforeTable !== afterTable,
  elementsFound: !!before.panelFound && !!before.tabFound && !!after.panelFound && !!after.tabFound,
  // Stage 6 orthogonality check (see header comment): the shell's OWN zoom
  // axis must stay at its fresh-open default across BOTH fontScale states —
  // fontScale must never write --viewer-zoom.
  viewerZoomVarBefore: before.viewerZoomVar,
  viewerZoomVarAfter: after.viewerZoomVar,
  viewerZoomVarUnaffectedByFontScale: before.viewerZoomVar === after.viewerZoomVar,
  errors,
};
result.allPass =
  result.beforePanelIs13px &&
  result.beforeTabIs12_5px &&
  result.beforeTableIs12_5px &&
  result.beforeCaptionIs12_5px &&
  result.afterPanelIs19_5px &&
  result.afterTabIs18_75px &&
  result.afterTableIs18_75px &&
  result.afterCaptionIs18_75px &&
  result.teardownRestoredTo13px &&
  result.panelRespondsToZoom &&
  result.tabRespondsToZoom &&
  result.tableRespondsToZoom &&
  result.elementsFound &&
  result.viewerZoomVarUnaffectedByFontScale &&
  errors.length === 0;

writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log("\nwrote", out);
console.log(result.allPass ? "\n✓ viewer-zoom-golden PASS" : "\n✗ viewer-zoom-golden FAIL");
await browser.close();
process.exit(result.allPass ? 0 : 1);
