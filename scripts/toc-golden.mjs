// CDP Golden Master for outline (table of contents) click-landing accuracy.
//
// The outline panel lists the document's headings; clicking one scrolls + places
// the caret on that heading line via the SAME jumpTo landing footnote navigation
// uses (center + caret + focus + async re-center). The core guard here is the
// FORWARD jump across a COLD async widget (mermaid): a heading sitting below a
// not-yet-rendered diagram must still land centered once the diagram settles —
// the same re-center contract footnote-golden locks, exercised through the
// outline click path (button toggle → `.outline-item` mousedown).
//
// jsdom has no layout, so tests/outline.test.ts can only assert the dispatch
// *shape* (jumpTo called with the right pos); this script is the SSOT for landing
// *accuracy* through the panel.
//
//   node scripts/toc-golden.mjs            # run, print PASS/FAIL + JSON
//   node scripts/toc-golden.mjs /tmp/toc.json
//
// Assumes `npm run dev:browser` + Chrome --remote-debugging-port=9222 running,
// page at localhost:1420/?file=x.md. (qa-verifier rewrites 9222→9333 / 1420→1430
// for the isolated profile, same `__iso__` sed pattern as the other harnesses.)
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "/tmp/toc-golden.json";
const url = process.argv[3] ?? "http://localhost:1420/?file=x.md";

// Landing tolerance: the heading's vertical center must sit within this many px
// of the viewport center after widgets settle. 60px ≈ a couple of lines — tight
// enough to catch an off-center regression, loose enough to absorb sub-line
// rounding and the clamp at document edges. Matches footnote-golden's TOL so the
// two share a calibration.
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

const hasHarness = await page.evaluate(() => !!window.__mermark);
if (!hasHarness) {
  console.error("window.__mermark missing — run `npm run dev:browser` (DEV build).");
  await browser.close();
  process.exit(2);
}

const sleep = (ms) => page.waitForTimeout(ms);

/** Hard-reload so ALL module-level caches reset — crucially the mermaid svgCache.
 *  The forward landing bug only manifests when the widget below the heading is
 *  COLD (cache miss): its height is an estimate at scroll time. */
async function reloadPage() {
  await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForFunction(() => !!window.__mermark, { timeout: 8000 });
  await sleep(400);
}

async function loadDoc(text, mode) {
  await page.evaluate(
    ({ text, mode }) => {
      const C = window.__mermark;
      C.setMode(mode);
      C.reloadFromFile(text, Date.now());
      C.view.dispatch({ selection: { anchor: 0 } });
      C.view.scrollDOM.scrollTop = 0;
    },
    { text, mode },
  );
  await sleep(200);
}

/** Open the outline panel via its footer button (lazy render on first toggle),
 *  then wait for the heading items to appear. The reload-from-file path doesn't
 *  fire docChanged on the new editor, so main.ts calls outline.refresh() on open;
 *  here we toggle the panel after loading the doc, which renders fresh. */
async function openOutline() {
  await page.evaluate(() => {
    const btn = document.querySelector(".outline-btn");
    const row = document.querySelector(".outline-row");
    if (row && row.hidden) btn?.click(); // open only if currently closed
    else if (row) {
      // already open from a previous scenario — re-render against the new doc
      btn?.click();
      btn?.click();
    }
  });
  await page
    .waitForFunction(() => document.querySelectorAll(".outline-item").length > 0, { timeout: 4000 })
    .catch(() => {});
  await sleep(150);
}

/** Screen-space center of the nth .outline-item, for a real mousedown. */
async function itemRect(nth) {
  return page.evaluate((nth) => {
    const el = document.querySelectorAll(".outline-item")[nth];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, nth);
}

async function mousedownAt(pt) {
  if (!pt) throw new Error("outline item not found for click");
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** Wait for any mermaid diagram to paint + the re-center settle window to run. */
async function settle() {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wantsMermaid = !!document.querySelector(".cm-mermaid");
    for (let i = 0; i < 40; i++) {
      if (!wantsMermaid || document.querySelector(".cm-mermaid svg")) break;
      await sleep(50);
    }
  });
  await sleep(1500); // SETTLE_WINDOW_MS (1200) + margin for the last rAF
}

/** How far a doc offset's vertical center sits from the viewport center, px. */
async function landingError(targetExpr) {
  return page.evaluate((targetExpr) => {
    const C = window.__mermark;
    const v = C.view;
    const target = eval(targetExpr);
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

// Doc offset of the line that starts with the given heading text (its line.from
// — exactly the pos the panel stamps into data-pos and feeds to jumpTo).
const headingPosExpr = (needle) =>
  `(()=>{const t=window.__mermark.view.state.doc;for(let n=1;n<=t.lines;n++){const L=t.line(n);if(L.text.replace(/^#+\\s*/,'').trim()===${JSON.stringify(needle)})return L.from;}return -1;})()`;

// ---- Test documents --------------------------------------------------------
const filler = (n) =>
  Array.from({ length: n }, (_, i) => `Paragraph line ${i} with some text here.`).join("\n\n");
const mermaidBlock = (salt) =>
  "```mermaid\ngraph TD\n" +
  `  S["cold ${salt}"] --> A[Start]\n` +
  "  A --> B[Step 1]\n  B --> C[Step 2]\n  C --> D[Step 3]\n  D --> E[Step 4]\n" +
  "  E --> F[Step 5]\n  F --> G[Step 6]\n  G --> H[End]\n```";

// "Target" heading sits in the MIDDLE, below a cold mermaid block, with trailing
// filler so the scroller has room to actually center it (not clamp).
const docWidgets = (salt) =>
  `# Top heading\n\nIntro near the top.\n\n${filler(16)}\n\n${mermaidBlock(salt)}\n\n## Target heading\n\nBody under the target.\n\n${filler(40)}`;
const docPlain = `# Top heading\n\n${filler(40)}\n\n## Target heading\n\n${filler(40)}`;

// ---- Scenario runner -------------------------------------------------------
const results = [];

/** Click the outline item whose text === `heading` and assert it lands centered.
 *  `cold` reloads the page first so the mermaid widget above the target is COLD. */
async function landingCase(name, doc, mode, heading, { cold = false, expectCentered = true } = {}) {
  if (cold) await reloadPage();
  await loadDoc(doc, mode);
  await openOutline();
  // Find the item index whose text matches the target heading.
  const idx = await page.evaluate((heading) => {
    const items = [...document.querySelectorAll(".outline-item")];
    return items.findIndex((el) => el.textContent === heading);
  }, heading);
  if (idx < 0) {
    const diag = await page.evaluate(() => ({
      items: [...document.querySelectorAll(".outline-item")].map((e) => e.textContent),
      harness: !!window.__mermark,
    }));
    console.error(`[${name}] target item not found — diag: ${JSON.stringify(diag)}`);
  }
  await mousedownAt(await itemRect(idx));
  await settle();
  const m = await landingError(headingPosExpr(heading));
  const pass = expectCentered ? m.error !== null && m.error <= TOL : m.inViewport;
  results.push({ name, mode, heading, ...m, tol: TOL, pass });
}

// 1. plain forward landing (baseline accuracy) — read + edit
await landingCase("plain forward (read)", docPlain, "read", "Target heading");
await landingCase("plain forward (edit)", docPlain, "edit", "Target heading");

// 2. COLD widget forward — THE core regression guard (re-center across mermaid).
await landingCase("widget forward cold (read)", docWidgets("r"), "read", "Target heading", {
  cold: true,
});
await landingCase("widget forward cold (edit)", docWidgets("e"), "edit", "Target heading", {
  cold: true,
});

const allPass = results.every((r) => r.pass) && consoleErrors.length === 0;

writeFileSync(out, JSON.stringify({ TOL, results, consoleErrors, allPass }, null, 2));
console.log(JSON.stringify({ TOL, results, consoleErrors, allPass }, null, 2));
console.log("\n" + (allPass ? "PASS" : "FAIL") + " — wrote " + out);
await browser.close();
process.exit(allPass ? 0 : 1);
