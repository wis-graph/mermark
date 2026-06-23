// Golden-master capture for the mermaid render pipeline. Reloads the live
// browser-mode page over CDP, waits for async mermaid render, and fingerprints
// every .cm-mermaid host geometrically (viewBox, svg sizing, fitted host
// height) plus a screenshot. Run before and after a refactor and diff.
//
//   node scripts/mermaid-golden.mjs /tmp/mermaid-before.json
//   node scripts/mermaid-golden.mjs /tmp/mermaid-after.json
//
// Assumes `npm run dev:browser` + Chrome --remote-debugging-port=9222 running.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "/tmp/mermaid-golden.json";
const url = process.argv[3] ?? "http://localhost:1420/?file=x.md";
const shot = out.replace(/\.json$/, ".png");

const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.setViewportSize({ width: 1200, height: 900 }); // deterministic layout
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2000); // mermaid async render + rAF layout/fit

// CM6 virtualizes lines: a mermaid block off-screen is never rendered, so
// .cm-mermaid count stays 0 unless we scroll the block into view. Scroll the
// scroller to the bottom in steps until at least one .cm-mermaid mounts (or we
// give up), then settle for the async mermaid render + rAF fit.
await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const scroller = document.querySelector(".cm-scroller");
  if (!scroller) return;
  for (let step = 0; step < 30; step++) {
    if (document.querySelector(".cm-mermaid svg")) break;
    scroller.scrollTop = Math.min(
      scroller.scrollTop + scroller.clientHeight * 0.8,
      scroller.scrollHeight,
    );
    await sleep(120);
  }
});
await page.waitForTimeout(1500); // mermaid async render after the block mounts

/** Geometry fingerprint of every mounted .cm-mermaid. The diagram is the svg
 *  itself now (no svg-pan-zoom viewport <g>); pan/zoom is a CSS `transform` on
 *  the svg. `svgRect` is the painted svg bbox (in screen px); contentClipLeft/
 *  Right measure how far the drawing spills past the host box (positive = inside,
 *  negative = clipped). emptyBand = host rendered height − painted svg height. */
const fpExpr = () => {
  const round = (n) => Math.round(n * 10) / 10;
  return [...document.querySelectorAll(".cm-mermaid")].map((host, i) => {
    const svg = host.querySelector("svg");
    // The drawing's own content box: prefer mermaid's root <g>, else the svg.
    const content = svg?.querySelector("g") ?? svg;
    const hostRect = host.getBoundingClientRect();
    const svgRect = svg?.getBoundingClientRect();
    const contentRect = content?.getBoundingClientRect();
    const cs = svg ? getComputedStyle(svg) : null;
    return {
      i,
      hostClientW: round(host.clientWidth),
      hostClientH: round(host.clientHeight),
      hostStyleHeight: host.style.height,
      hostStyleMinHeight: host.style.minHeight,
      hasSvg: !!svg,
      viewBox: svg?.getAttribute("viewBox") ?? null,
      hasHeightAttr: svg?.hasAttribute("height") ?? null,
      svgStyleWidth: svg?.style.width ?? null,
      svgStyleHeight: svg?.style.height ?? null,
      svgStyleMaxWidth: svg?.style.maxWidth ?? null,
      svgOverflow: cs?.overflow ?? null,
      // CSS-transform pan/zoom snapshot (replaces hasPanZoomViewport).
      svgTransform: cs?.transform ?? null, // "none" at rest, matrix(...) when zoomed
      svgTransformOrigin: cs?.transformOrigin ?? null, // "0px 0px" when handler attached
      // symptom 1 (clipping): how far the painted content sits inside the host.
      contentClipLeft: contentRect ? round(contentRect.left - hostRect.left) : null,
      contentClipRight: contentRect ? round(hostRect.right - contentRect.right) : null,
      // symptom 2 (empty band): host rendered height vs the painted content height.
      paintedContentHeight: contentRect ? round(contentRect.height) : null,
      svgRectHeight: svgRect ? round(svgRect.height) : null,
      emptyBand: contentRect ? round(hostRect.height - contentRect.height) : null,
    };
  });
};

const fp = await page.evaluate(fpExpr);

await page
  .locator(".cm-mermaid")
  .first()
  .screenshot({ path: shot })
  .catch(() => {});

// Zoom pass (symptom 1 regression): dblclick the first diagram to toggle zoom,
// then re-measure how far content spills past the host. before-fix: ~±318px out
// (clipped). after-fix: content clipped at the svg box, stays inside the host.
await page
  .locator(".cm-mermaid")
  .first()
  .dblclick()
  .catch(() => {});
await page.waitForTimeout(400);
const fpZoom = await page.evaluate(fpExpr);
await page
  .locator(".cm-mermaid")
  .first()
  .screenshot({ path: shot.replace(/\.png$/, ".zoom.png") })
  .catch(() => {});

writeFileSync(out, JSON.stringify({ fp, fpZoom, errors }, null, 2));
console.log(JSON.stringify({ count: fp.length, fp, fpZoom, errors }, null, 2));
console.log("\nwrote", out, "+", shot);
await browser.close();
