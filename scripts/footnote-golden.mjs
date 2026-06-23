// CDP Golden Master for footnote forward/backward click navigation accuracy.
//
// The bug: clicking a reference chip `[^name]` jumps DOWN to its definition, but
// when async live-preview widgets (mermaid / KaTeX) sit between the reference and
// the definition, the definition lands OFF-CENTER — CM scrolls using the height
// map's estimate of those not-yet-rendered widgets, then discards the scroll
// target before they settle. Backward jumps (def marker → reference, UP into
// already-measured space) were always accurate. This harness reproduces the
// asymmetry numerically: it injects test docs, drives a real chip mousedown,
// waits for the widgets to settle, and asserts the definition's vertical center
// is within TOL of the viewport center. The widget-full forward case is the core
// regression guard — it FAILS on the unfixed code and PASSES after the re-center.
//
// jsdom has no layout, so vitest can only assert the dispatch *shape*; this
// script is the SSOT for landing *accuracy*.
//
//   node scripts/footnote-golden.mjs            # run, print PASS/FAIL + JSON
//   node scripts/footnote-golden.mjs /tmp/footnote.json
//
// Assumes `npm run dev:browser` + Chrome --remote-debugging-port=9222 running,
// page at localhost:1420/?file=x.md. (qa-verifier rewrites 9222→9333 / 1420→1430
// for the isolated profile, same `__iso__` sed pattern as the nav harness.)
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "/tmp/footnote-golden.json";
const url = process.argv[3] ?? "http://localhost:1420/?file=x.md";

// Landing tolerance: the definition's vertical center must sit within this many
// px of the viewport center after widgets settle. 60px ≈ a couple of lines — far
// tighter than the multi-hundred-px leap the bug produces, loose enough to absorb
// sub-line rounding and the clamp at document edges. Calibrated against the
// widget-LESS baseline (which is always accurate) so a regression in the widget
// case shows up as a TOL breach, not noise.
const TOL = 60;

const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
page.on("console", (m) => {
  const t = m.type();
  if (t === "error" || t === "warning") consoleErrors.push(`console.${t}: ${m.text()}`);
});

await page.setViewportSize({ width: 1000, height: 800 }); // deterministic layout
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(800);

// Sanity: the dev harness handle must be present (DEV build) — we read ground
// truth from it (view geometry, doc lines) and use it to inject test docs.
const hasHarness = await page.evaluate(() => !!window.__mermark);
if (!hasHarness) {
  console.error("window.__mermark missing — run `npm run dev:browser` (DEV build).");
  await browser.close();
  process.exit(2);
}

const sleep = (ms) => page.waitForTimeout(ms);

/** Hard-reload the page so ALL module-level caches reset — crucially the mermaid
 *  svgCache. The forward bug only manifests when the widget below the reference
 *  is COLD (cache miss): its height is an estimate at scroll time, so the def
 *  lands off-center until re-centered. Without this, a second run would hit the
 *  warm cache, render synchronously, and never reproduce the bug. */
async function reloadPage() {
  await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForFunction(() => !!window.__mermark, { timeout: 8000 });
  await sleep(400);
}

// Replace the document and set the mode. reloadFromFile is the controller's
// doc-swap path (same one the file watcher uses); setMode flips read/edit.
async function loadDoc(text, mode) {
  await page.evaluate(
    ({ text, mode }) => {
      const C = window.__mermark;
      C.setMode(mode);
      C.reloadFromFile(text, Date.now());
      C.view.dispatch({ selection: { anchor: 0 } });
      C.view.scrollDOM.scrollTop = 0; // deterministic cold start at the top
    },
    { text, mode },
  );
  // Wait for the live-preview decorations to mount (the ref chip near the top is
  // always in the initial viewport once parsed) before any click measurement.
  await page
    .waitForFunction(() => document.querySelector(".cm-footnote-ref"), { timeout: 4000 })
    .catch(() => {});
  await sleep(200);
}

/** Screen-space rect of the .cm-footnote-ref / .cm-footnote-def-marker chips, so
 *  Playwright can dispatch a real mousedown at the chip's center (driving the
 *  capture-phase footnoteNav listener exactly like a user click). */
async function chipRect(selector, nth = 0) {
  return page.evaluate(
    ({ selector, nth }) => {
      const el = document.querySelectorAll(selector)[nth];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    { selector, nth },
  );
}

async function mousedownAt(pt, { alt = false } = {}) {
  if (!pt) throw new Error("chip not found for click");
  if (alt) await page.keyboard.down("Alt");
  // A full mousedown→up at the chip center; footnoteNav acts on mousedown.
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
}

/** Wait until any mermaid diagram has painted (svg present) and a couple of rAF
 *  frames have elapsed, so the re-center settle window has run. No-op when the
 *  doc has no diagram. */
async function settle() {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wantsMermaid = !!document.querySelector(".cm-mermaid");
    for (let i = 0; i < 40; i++) {
      if (!wantsMermaid || document.querySelector(".cm-mermaid svg")) break;
      await sleep(50);
    }
  });
  await sleep(1500); // covers SETTLE_WINDOW_MS (1200) + a margin for the last rAF
}

/** Ground-truth landing measurement: how far the target position's vertical
 *  center sits from the viewport center, in px. <= TOL means "centered". */
async function landingError(targetExpr) {
  return page.evaluate((targetExpr) => {
    const C = window.__mermark;
    const v = C.view;
    const target = eval(targetExpr); // a doc offset, computed against the live doc
    const c = v.coordsAtPos(target);
    if (!c) return { error: null, reason: "coordsAtPos null (off-screen)" };
    const scRect = v.scrollDOM.getBoundingClientRect();
    const targetCenterY = (c.top + c.bottom) / 2;
    const viewportCenterY = scRect.top + scRect.height / 2;
    return {
      error: Math.abs(targetCenterY - viewportCenterY),
      targetCenterY: Math.round(targetCenterY),
      viewportCenterY: Math.round(viewportCenterY),
      inViewport: c.top >= scRect.top && c.bottom <= scRect.bottom,
      scrollTop: Math.round(v.scrollDOM.scrollTop),
    };
  }, targetExpr);
}

// Doc offset expressions (evaluated in-page against the live doc text).
const defPosExpr = `(()=>{const t=window.__mermark.view.state.doc;for(let n=1;n<=t.lines;n++){const L=t.line(n);if(/^\\[\\^1\\]:/.test(L.text))return L.from;}return -1;})()`;
const refPosExpr = `(()=>{const t=window.__mermark.view.state.doc;for(let n=1;n<=t.lines;n++){const L=t.line(n);if(!/^\\[\\^1\\]:/.test(L.text)){const c=L.text.indexOf('[^1]');if(c!==-1)return L.from+c;}}return -1;})()`;

// ---- Test documents --------------------------------------------------------
// Centering is only POSSIBLE when the definition is far enough from both ends
// that scrollTop isn't clamped. So the centered-forward docs put filler BEFORE
// the reference, the reference near the top, the definition in the MIDDLE, and
// more filler AFTER the definition — giving the scroller room to actually center
// the def. (The clamp scenario deliberately omits trailing filler.)
const filler = (n) =>
  Array.from({ length: n }, (_, i) => `Paragraph line ${i} with some text here.`).join("\n\n");
// A UNIQUE mermaid source per scenario (the `salt` node) so the svgCache always
// misses → the diagram is COLD when the forward click happens, reproducing the
// height-estimate-at-scroll-time bug. The big subgraph also makes the diagram
// tall, magnifying any estimation error.
const mermaidBlock = (salt) =>
  "```mermaid\ngraph TD\n" +
  `  S["cold ${salt}"] --> A[Start]\n` +
  "  A --> B[Step 1]\n  B --> C[Step 2]\n  C --> D[Step 3]\n  D --> E[Step 4]\n" +
  "  E --> F[Step 5]\n  F --> G[Step 6]\n  G --> H[End]\n```";
const mathBlock = "$$\n\\sum_{i=0}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}\n$$";

const docWidgetless = `# Footnotes (no widgets)\n\nIntro paragraph with a reference [^1] to follow.\n\n${filler(40)}\n\n[^1]: This is the definition in the middle, far below the reference.\n\n${filler(40)}`;
const docWidgets = (salt) =>
  `# Footnotes (with widgets)\n\nIntro paragraph with a reference [^1] to follow.\n\n${filler(20)}\n\n${mermaidBlock(salt)}\n\n${mathBlock}\n\n${filler(20)}\n\n[^1]: This is the definition below the big async widgets.\n\n${filler(40)}`;
const docClamp = `# Footnotes (def at end)\n\nReference [^1] near the top.\n\n${filler(40)}\n\n[^1]: Definition on the very last line.`;

// ---- Scenario runner -------------------------------------------------------
const results = [];

async function forwardCase(name, doc, mode, { expectCentered = true, cold = false } = {}) {
  if (cold) await reloadPage(); // reset the mermaid cache so the widget is COLD
  await loadDoc(doc, mode);
  const pt = await chipRect(".cm-footnote-ref", 0);
  if (!pt) {
    const diag = await page.evaluate(() => ({
      refs: document.querySelectorAll(".cm-footnote-ref").length,
      harness: !!window.__mermark,
      line3: window.__mermark?.view.state.doc.line(3).text?.slice(0, 40),
    }));
    console.error(`[${name}] no ref chip — diag: ${JSON.stringify(diag)}`);
  }
  await mousedownAt(pt);
  await settle();
  const m = await landingError(defPosExpr);
  const pass = expectCentered ? m.error !== null && m.error <= TOL : m.inViewport;
  results.push({ name, mode, dir: "forward", ...m, tol: TOL, pass });
}

async function backwardCase(name, doc, mode) {
  await loadDoc(doc, mode);
  // CM virtualizes lines: the bottom def line isn't in the DOM at a top scroll,
  // so its marker chip can't be clicked. Scroll the def into view first (this is
  // exactly the post-forward-jump state the user clicks back from), then click
  // the def marker to jump UP to the first reference.
  await page.evaluate((defPosExpr) => {
    const C = window.__mermark;
    const target = eval(defPosExpr);
    C.view.dispatch({ effects: C.view.constructor.scrollIntoView(target, { y: "center" }) });
  }, defPosExpr);
  await settle();
  const pt = await chipRect(".cm-footnote-def-marker", 0);
  await mousedownAt(pt);
  await settle();
  const m = await landingError(refPosExpr);
  // Backward jumps UP toward a reference near the document top, where centering
  // clamps at scrollTop 0. The faithful no-regression invariant from the bug
  // report is "the reference becomes visible" (it was always correct), so we
  // assert in-viewport; the center error is still recorded for the diff.
  results.push({ name, mode, dir: "backward", ...m, tol: TOL, pass: m.inViewport === true });
}

async function altNoopCase(name, doc) {
  await loadDoc(doc, "read");
  const before = await page.evaluate(() => window.__mermark.view.scrollDOM.scrollTop);
  const pt = await chipRect(".cm-footnote-ref", 0);
  await mousedownAt(pt, { alt: true }); // Alt+click = escape hatch, no navigation
  await sleep(300);
  const after = await page.evaluate(() => window.__mermark.view.scrollDOM.scrollTop);
  results.push({ name, dir: "alt-noop", before, after, pass: Math.abs(after - before) < 4 });
}

// 1. widget-less forward (baseline accuracy) — read + edit
await forwardCase("widgetless forward (read)", docWidgetless, "read");
await forwardCase("widgetless forward (edit)", docWidgetless, "edit");

// 2. widget-full COLD forward — THE core regression guard. Each reloads the page
// (fresh mermaid cache) and uses a unique diagram source so the widget is cold
// at click time; the unfixed code lands the def off-center here.
await forwardCase("widget forward cold (read)", docWidgets("r"), "read", { cold: true });
await forwardCase("widget forward cold (edit)", docWidgets("e"), "edit", { cold: true });

// 3. backward no-regression — same doc, UP into measured space
await backwardCase("widget backward (read)", docWidgets("b"), "read");
await backwardCase("widgetless backward (read)", docWidgetless, "read");

// 4. clamp — definition on the last line, center impossible → must be in viewport
await forwardCase("clamp forward def-at-end (read)", docClamp, "read", { expectCentered: false });

// 5. Alt+click = no-op (no scroll), and console must be clean
await altNoopCase("alt+click no-op", docWidgetless);

const allPass = results.every((r) => r.pass) && consoleErrors.length === 0;

writeFileSync(out, JSON.stringify({ TOL, results, consoleErrors, allPass }, null, 2));
console.log(JSON.stringify({ TOL, results, consoleErrors, allPass }, null, 2));
console.log("\n" + (allPass ? "PASS" : "FAIL") + " — wrote " + out);
await browser.close();
process.exit(allPass ? 0 : 1);
