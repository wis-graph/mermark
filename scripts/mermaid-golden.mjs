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

const fp = await page.evaluate(() => {
  const round = (n) => Math.round(n);
  return [...document.querySelectorAll(".cm-mermaid")].map((host, i) => {
    const svg = host.querySelector("svg");
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
      hasPanZoomViewport: !!svg?.querySelector(".svg-pan-zoom_viewport"),
    };
  });
});

await page
  .locator(".cm-mermaid")
  .first()
  .screenshot({ path: shot })
  .catch(() => {});

writeFileSync(out, JSON.stringify({ fp, errors }, null, 2));
console.log(JSON.stringify({ count: fp.length, fp, errors }, null, 2));
console.log("\nwrote", out, "+", shot);
await browser.close();
