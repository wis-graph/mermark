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

const out = process.argv[2] ?? "/tmp/settings-golden.json";
const url = process.argv[3] ?? "http://localhost:1420/?file=x.md";

const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
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
      mermaidHasPanZoom: !!document.querySelector(".cm-mermaid .svg-pan-zoom_viewport"),
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

writeFileSync(out, JSON.stringify({ states, errors }, null, 2));
console.log(JSON.stringify({ states, errors }, null, 2));
console.log("\nwrote", out);
await browser.close();
