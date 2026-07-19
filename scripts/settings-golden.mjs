// CDP Golden Master for settings behavior: theme dataset + persistence, mermaid
// re-render on theme switch, mode editability + persistence, button labels.
// Resets localStorage so each run starts from the system default, then drives
// the toggles and fingerprints observable state at each step.
//
//   node scripts/settings-golden.mjs /tmp/settings-before.json   (pre-refactor)
//   node scripts/settings-golden.mjs /tmp/settings-after.json    (post-refactor)
//
// Assumes `npm run dev:browser` + Chrome --remote-debugging-port=9222 running.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { assertPageRendered } from "./lib/preflight.mjs";

const out = process.argv[2] ?? "/tmp/settings-golden.json";
const url = process.argv[3] ?? "http://localhost:1430/?file=x.md";

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
// deterministic start: clear persisted prefs, reload to system default
await page.evaluate(() => localStorage.clear());
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2000); // mermaid async render

// Refuse to measure a page that never rendered — see scripts/lib/preflight.mjs.
await assertPageRendered(page, { context: "settings-golden" });

const snap = (label) =>
  page.evaluate((label) => {
    const m = document.querySelector(".cm-mermaid svg");
    const content = document.querySelector(".cm-content");
    return {
      label,
      dataTheme: document.documentElement.dataset.theme ?? null,
      lsTheme: localStorage.getItem("mermark.theme"),
      lsMode: localStorage.getItem("mermark.mode"),
      editable: content?.getAttribute("contenteditable") ?? null,
      mermaidViewBox: m?.getAttribute("viewBox") ?? null,
      // CSS-transform pan/zoom is attached when the svg carries transform-origin
      // 0 0 (handler ran); off mode leaves it unset → "" (no svg-pan-zoom node).
      mermaidPanZoomOrigin: m ? getComputedStyle(m).transformOrigin : null,
      themeBtn: document.querySelector(".theme-toggle")?.textContent ?? null,
      modeBtn: document.querySelector(".mode-toggle")?.textContent ?? null,
    };
  }, label);

const states = [];
states.push(await snap("initial"));

await page.click(".theme-toggle");
await page.waitForTimeout(1500); // theme re-bakes + re-renders mermaid
states.push(await snap("after-theme-toggle"));

await page.click(".mode-toggle");
await page.waitForTimeout(500);
states.push(await snap("after-mode-toggle"));

await page.click(".theme-toggle");
await page.click(".mode-toggle");
await page.waitForTimeout(1500);
states.push(await snap("after-toggle-back"));

// ── headingFontSetting (2026-07-14, 01_headingfont.md §7 golden scenarios) ──
// Cold-load gate FIRST, before anything selects Paperlogy: with the default
// setting ("" / 테마 기본) untouched, no paperlogy woff2 should ever have been
// fetched — the @font-face declaration alone must not cost network.
const coldLoadResources = await page.evaluate(() =>
  performance.getEntriesByType("resource").map((r) => r.name),
);
const paperlogyColdLoadCount = coldLoadResources.filter((n) => n.toLowerCase().includes("paperlogy")).length;

// Open settings → 타이포그래피 category → find the "제목 글꼴" select.
await page.click(".settings-btn");
await page.waitForTimeout(200);
const catButtons = await page.$$(".settings-cat");
for (const b of catButtons) {
  const text = await b.textContent();
  if (text?.trim() === "타이포그래피") {
    await b.click();
    break;
  }
}
await page.waitForTimeout(200);

const headingFontSnap = (label) =>
  page.evaluate((label) => {
    const heading = document.querySelector(".cm-heading");
    return {
      label,
      headingFontFamily: heading ? getComputedStyle(heading).fontFamily : null,
      headingOffsetHeight: heading ? heading.offsetHeight : null, // ZOOM GUARD probe (§5)
      lsHeadingFont: localStorage.getItem("mermark.headingFont"),
    };
  }, label);

const headingStates = [];
headingStates.push({ ...(await headingFontSnap("panel-render-default")), paperlogyColdLoadCount });

// Panel-render assertion: the select exists with 3 options.
const selectOptionLabels = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll(".settings-row"));
  const row = rows.find((r) => r.querySelector(".settings-row-label")?.textContent?.trim() === "제목 글꼴");
  const select = row?.querySelector("select");
  return select ? Array.from(select.options).map((o) => o.textContent) : null;
});
headingStates.push({ label: "panel-options", selectOptionLabels });

// Select Paperlogy → assert (a) computed font-family starts with Paperlogy,
// (b) document.fonts.check proves the Hangul glyph is actually served by the
// Paperlogy face (not a fallback that merely LOOKS selected).
async function chooseHeadingFont(label) {
  await page.evaluate((wantLabel) => {
    const rows = Array.from(document.querySelectorAll(".settings-row"));
    const row = rows.find((r) => r.querySelector(".settings-row-label")?.textContent?.trim() === "제목 글꼴");
    const select = row.querySelector("select");
    const opt = Array.from(select.options).find((o) => o.textContent === wantLabel);
    select.value = opt.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, label);
  await page.waitForTimeout(150);
}

await chooseHeadingFont("Paperlogy (한글)");
await page.waitForTimeout(300);
const paperlogyGlyphCheck = await page.evaluate(async () => {
  await document.fonts.ready;
  return document.fonts.check('600 16px Paperlogy', "한");
});
headingStates.push({ ...(await headingFontSnap("after-select-paperlogy")), paperlogyGlyphCheck });

// Back to 테마 기본: computed font-family should revert to the theme default
// (claude's Georgia) via the removeProperty path — the precedence rule (§2).
await chooseHeadingFont("테마 기본");
await page.waitForTimeout(150);
headingStates.push(await headingFontSnap("back-to-theme-default"));

// Explicit Georgia selection: observationally identical to claude's own
// theme-default Georgia (byte-identical stack, §1).
await chooseHeadingFont("Georgia (Serif)");
await page.waitForTimeout(150);
headingStates.push(await headingFontSnap("after-select-georgia"));

// ── viewer on/off toggle (_workspace/03_viewer_toggle_design.md) ───────────
// The settings modal is already open (헤딩폰트 블록 above). Switch to the 뷰어
// category and assert the 5 built-in/extension viewers each render a row,
// and that a toggle click actually writes the disabled-set to localStorage.
const viewerCatButtons = await page.$$(".settings-cat");
for (const b of viewerCatButtons) {
  const text = await b.textContent();
  if (text?.trim() === "뷰어") {
    await b.click();
    break;
  }
}
await page.waitForTimeout(200);

const viewerToggleRows = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".settings-vtoggle-item")).map((el) => ({
    id: el.getAttribute("data-id"),
    label: el.querySelector(".settings-vtoggle-label")?.textContent ?? null,
  })),
);

async function clickViewerToggle(id, segLabel) {
  await page.evaluate(
    ({ id, segLabel }) => {
      const row = document.querySelector(`.settings-vtoggle-item[data-id="${id}"]`);
      const btn = Array.from(row.querySelectorAll(".settings-seg-btn")).find(
        (b) => b.textContent === segLabel,
      );
      btn.click();
    },
    { id, segLabel },
  );
  await page.waitForTimeout(100);
}

await clickViewerToggle("ext.pdf", "끄기");
const disabledAfterOff = await page.evaluate(() => localStorage.getItem("mermark.disabledViewers"));
await clickViewerToggle("ext.pdf", "켜기");
const disabledAfterOn = await page.evaluate(() => localStorage.getItem("mermark.disabledViewers"));

const viewerToggleState = {
  rows: viewerToggleRows,
  rowCount: viewerToggleRows.length,
  hasAllFive: ["image", "hwp", "ext.excel", "ext.html", "ext.pdf"].every((id) =>
    viewerToggleRows.some((r) => r.id === id),
  ),
  disabledAfterOff,
  disabledAfterOn,
  toggleWritesAndRoundTrips:
    !!disabledAfterOff &&
    JSON.parse(disabledAfterOff).includes("ext.pdf") &&
    !!disabledAfterOn &&
    !JSON.parse(disabledAfterOn).includes("ext.pdf"),
};

await page.click(".settings-close");
await page.waitForTimeout(200);

writeFileSync(
  out,
  JSON.stringify({ states, headingStates, viewerToggleState, errors }, null, 2),
);
console.log(JSON.stringify({ states, headingStates, viewerToggleState, errors }, null, 2));
console.log("\nwrote", out);
await browser.close();
