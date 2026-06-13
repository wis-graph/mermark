// Deterministic cursor-navigation trace harness for the live-preview editor.
// Reads GROUND TRUTH (view.state.selection) via the dev-only window.__mermark,
// instead of guessing from rendered DOM. Use to verify keyboard block-entry.
//
//   node scripts/nav-trace.mjs            # run the standard regression cases
//
// Requires: `npm run dev:browser` running, and Chrome on CDP :9222 with the page
// at localhost:1420/?file=x.md  (open with --remote-debugging-port=9222).
import { chromium } from "playwright";

const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const b = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const p = b.contexts().flatMap((c) => c.pages()).find((pg) => pg.url().includes("1420"));
await p.setViewportSize({ width: 1200, height: 1000 });
await p.goto("http://localhost:1420/?file=x.md", { waitUntil: "networkidle" });
await p.waitForTimeout(1200);

await p.evaluate(() => {
  const C = window.__mermark;
  if (!C) throw new Error("window.__mermark missing — is import.meta.env.DEV true?");
  window.__t = {
    edit() { C.setMode("edit"); },
    lineNum(s) { const d = C.view.state.doc; for (let n = 1; n <= d.lines; n++) if (d.line(n).text.includes(s)) return n; return -1; },
    put(n) { const L = C.view.state.doc.line(n); C.view.focus(); C.view.dispatch({ selection: { anchor: L.from } }); },
    here() { const v = C.view, h = v.state.selection.main.head, L = v.state.doc.lineAt(h); return { line: L.number, col: h - L.from, text: L.text.slice(0, 24) }; },
    blocks() { return { mermaid: !!document.querySelector(".cm-mermaid svg"), table: document.querySelectorAll(".cm-table").length, math: document.querySelectorAll(".cm-math-block").length }; },
  };
});
const num = (s) => p.evaluate((s) => window.__t.lineNum(s), s);
const here = () => p.evaluate(() => window.__t.here());
const blocks = () => p.evaluate(() => window.__t.blocks());
await p.evaluate(() => window.__t.edit());
await p.waitForTimeout(300);

async function trace(label, startSubstr, key, presses) {
  const n = await num(startSubstr);
  await p.evaluate((n) => window.__t.put(n), n);
  await p.waitForTimeout(120);
  const rows = [];
  let prev = await here();
  rows.push(`start  L${prev.line} c${prev.col} «${prev.text}»`);
  for (let i = 0; i < presses; i++) {
    await p.keyboard.press(key);
    await p.waitForTimeout(110);
    const h = await here();
    const delta = h.line - prev.line;
    const bl = await blocks();
    rows.push(`${key === "ArrowDown" ? "↓" : "↑"}  L${h.line} c${h.col} (Δ${delta >= 0 ? "+" : ""}${delta}) «${h.text}» blocks=${JSON.stringify(bl)}`);
    prev = h;
  }
  console.log(`\n=== ${label} ===\n${rows.join("\n")}`);
}

await trace("CODE BLOCK — down (want每 press +1 doc line, land on ```ts)", "## Code block", "ArrowDown", 7);
await trace("MERMAID — down (want reveal on entry, no leap)", "## Mermaid", "ArrowDown", 4);
await trace("MATH — down (want reveal on entry)", "## Math", "ArrowDown", 4);
await trace("TABLE — down (control)", "## Table", "ArrowDown", 4);
await trace("UP from Image (want no multi-line leap; reveal math)", "## Image", "ArrowUp", 8);

await b.close();
