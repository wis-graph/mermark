// Connect to Chrome over the CDP WebSocket (the "socket") and capture everything
// the frontend does: console, uncaught errors, failed requests. Then screenshot.
//
//   node scripts/cdp-debug.mjs "http://localhost:1420/?file=x.md"
//
// Assumes Chrome already launched with --remote-debugging-port=9222.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { assertPageRendered } from "./lib/preflight.mjs";

const url = process.argv[2] ?? "http://localhost:1420/?file=x.md";

// 1. find the CDP socket endpoint Chrome opened
const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const ws = ver.webSocketDebuggerUrl;
console.log("[cdp] socket:", ws);

// 2. attach to the live Chrome over that socket
const browser = await chromium.connectOverCDP(ws);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

const events = [];
page.on("console", (m) =>
  events.push({ kind: "console", level: m.type(), text: m.text(), loc: m.location() }),
);
page.on("pageerror", (e) =>
  events.push({ kind: "pageerror", text: e.message, stack: e.stack }),
);
page.on("requestfailed", (r) =>
  events.push({ kind: "requestfailed", url: r.url(), err: r.failure()?.errorText }),
);
page.on("response", (r) => {
  if (r.status() >= 400)
    events.push({ kind: "http", status: r.status(), url: r.url() });
});

// 3. drive the page
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 }).catch((e) =>
  events.push({ kind: "nav-error", text: String(e) }),
);
await page.waitForTimeout(1500); // let mermaid/katex async render

// Refuse to measure a page that never rendered — see scripts/lib/preflight.mjs.
await assertPageRendered(page, { context: "cdp-debug" });

// 4. probe the DOM for render results
const dom = await page.evaluate(() => ({
  title: document.title,
  appHTML: document.querySelector("#app")?.innerHTML.slice(0, 300) ?? null,
  mermaidSvgs: document.querySelectorAll(".cm-mermaid svg").length,
  mermaidErrors: [...document.querySelectorAll(".cm-mermaid-error")].map((e) => e.textContent),
  katex: document.querySelectorAll(".katex").length,
  images: [...document.querySelectorAll("img")].map((i) => ({
    src: i.getAttribute("src"),
    loaded: i.complete && i.naturalWidth > 0,
  })),
  wikilinks: document.querySelectorAll("[data-href], .cm-wikilink, a[href]").length,
  bodyText: document.body.innerText.slice(0, 200),
}));

await page.screenshot({ path: "/tmp/mermark-shot.png", fullPage: true }).catch(() => {});

writeFileSync("/tmp/mermark-cdp.json", JSON.stringify({ dom, events }, null, 2));
console.log("\n=== DOM PROBE ===");
console.log(JSON.stringify(dom, null, 2));
console.log("\n=== EVENTS (" + events.length + ") ===");
for (const e of events) console.log(JSON.stringify(e));
console.log("\nscreenshot: /tmp/mermark-shot.png  json: /tmp/mermark-cdp.json");

await browser.close();
