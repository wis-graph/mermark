// Deterministic cursor-navigation trace harness for the live-preview editor.
// Reads GROUND TRUTH (view.state.selection) via the dev-only window.__mermark,
// instead of guessing from rendered DOM. Use to verify keyboard block-entry.
//
//   node scripts/nav-trace.mjs            # run the standard regression cases
//
// Requires: `npm run dev:browser` running, and Chrome on CDP :9222 with the page
// at localhost:1430/?file=x.md  (open with --remote-debugging-port=9222).
import { chromium } from "playwright";
import { assertPageRendered } from "./lib/preflight.mjs";

const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const b = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const p = b.contexts().flatMap((c) => c.pages()).find((pg) => pg.url().includes("1430")) ?? b.contexts().flatMap((c) => c.pages())[0];
await p.setViewportSize({ width: 1200, height: 1000 });
await p.goto("http://localhost:1430/?file=x.md", { waitUntil: "networkidle" });
await p.waitForTimeout(1200);

await p.evaluate(() => {
  const C = window.__mermark;
  if (!C) throw new Error("window.__mermark missing — is import.meta.env.DEV true?");
  window.__t = {
    edit() { C.setMode("edit"); },
    lineNum(s) { const d = C.view.state.doc; for (let n = 1; n <= d.lines; n++) if (d.line(n).text.includes(s)) return n; return -1; },
    put(n) { const L = C.view.state.doc.line(n); C.view.focus(); C.view.dispatch({ selection: { anchor: L.from } }); },
    // The caret's landing spot, reported as a DETERMINISTIC observable.
    //
    // `col` is canonicalized (canonicalCol below) rather than reported raw. WHY
    // — do not "simplify" this back to `h - L.from`, it is what stops this
    // golden from flip-flopping between runs:
    //
    // Vertical motion (CM6 moveVertically → posAtCoords, view/dist/index.js:3688)
    // picks its landing position by scanning PIXEL X, not by counting characters.
    // At the moment of an ArrowUp INTO a heading, the caret is still on the line
    // below, so the heading's `## ` is CONCEALED (the heading feature hides the
    // marker whenever the selection isn't touching the line). A concealed range
    // is zero-width, so doc positions 0,1,2,3 all render at the SAME x — the left
    // edge of the first visible glyph ("M" of "Math"). Choosing among them is a
    // sub-pixel tie-break between positions that are visually the same place, and
    // it flips run to run with font metrics and measure timing (the async mermaid
    // render above keeps dirtying layout). The same tree yields c0 and c3.
    //
    // Two things this is NOT, both ruled out by measurement:
    //   - Not the posAtCoordsImprecise fallback (index.js:3795): that needs the
    //     target line to be OUTSIDE view.viewport, and it is inside the viewport
    //     on the c0 runs too.
    //   - Not a stale measure: forcing readMeasured before every press (settle()
    //     below) still flipped 1 run in 5.
    // And it cannot be fixed by measuring differently at read time: once the
    // caret lands on the heading the line REVEALS, so `## ` is visible again and
    // positions 0 and 3 are genuinely distinct by then. The ambiguity exists only
    // at the instant of the decision, which the harness cannot re-observe.
    //
    // So the trace reports the caret's VISUAL column under the concealed
    // rendering that the motion actually saw: any position inside a leading
    // marker that was hidden at decision time folds to the first visible glyph
    // (c0 → c3). Ordinary text is untouched — a real goal-column landing like
    // c46 inside a code block still reports 46. The golden then compares a
    // well-defined visual location instead of an ambiguous internal offset.
    // This matches the trace's declared intent ("no multi-line leap; reveal
    // math"), which is about WHICH LINE the caret reaches and whether the block
    // reveals — never about which side of a hidden marker it parks on.
    here() {
      const v = C.view, h = v.state.selection.main.head, L = v.state.doc.lineAt(h);
      return { line: L.number, col: canonicalCol(L, h), text: L.text.slice(0, 24) };
    },
    blocks() { return { mermaid: !!document.querySelector(".cm-mermaid svg"), table: document.querySelectorAll(".cm-table").length, math: document.querySelectorAll(".cm-math-block").length }; },
    // Force CM6 to flush its pending measure cycle before the next keypress, so
    // the press reads a settled layout rather than whatever the rAF loop happened
    // to have finished. coordsAtPos() calls readMeasured() internally. This alone
    // does not make the trace deterministic (see here() above) — it just removes
    // one of the two sources of noise.
    settle() { C.view.coordsAtPos(C.view.state.selection.main.head); },
  };

  /** The caret's column, canonicalized to the visual position the vertical move
   *  actually chose among (see here() for the full why). A leading ATX heading
   *  marker is concealed while the selection is elsewhere, so every position
   *  from the line start through the end of that marker rendered at the same x
   *  when the motion picked a landing spot — they are one visual location, and
   *  which of them CM's pixel scan returns is a coin-flip. Fold them onto the
   *  first visible glyph. Every other column is reported as-is. Pure query. */
  function canonicalCol(line, head) {
    const raw = head - line.from;
    const marker = /^#{1,6}[ \t]+/.exec(line.text); // the conceal-on-blur prefix
    return marker && raw <= marker[0].length ? marker[0].length : raw;
  }
});
const num = (s) => p.evaluate((s) => window.__t.lineNum(s), s);
const here = () => p.evaluate(() => window.__t.here());
const blocks = () => p.evaluate(() => window.__t.blocks());
const settle = () => p.evaluate(() => window.__t.settle());
await p.evaluate(() => window.__t.edit());
// Warm the layout before tracing, and don't start until the widget snapshot has
// stopped moving. WHY: CodeMirror VIRTUALIZES — a block far down the document is
// not in the DOM until it is scrolled near, and which blocks fall inside the
// render range is derived from ESTIMATED line heights. The mermaid widget renders
// off a promise and changes the height of everything below it, so on some runs the
// first trace began while `blocks` still read {mermaid:false, math:0} and on others
// {mermaid:true, math:1} — same caret path, different printed snapshot. Scrolling
// once to the bottom and back forces every block to render and be MEASURED (CM
// caches real heights), after which the render range is stable; then we wait for
// two consecutive identical snapshots so nothing is still settling.
await p.evaluate(async () => {
  const sc = window.__mermark.view.scrollDOM;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  sc.scrollTop = sc.scrollHeight;
  await frame();
  sc.scrollTop = 0;
  await frame();
});
for (let i = 0, prev = ""; i < 40; i++) {
  const snap = JSON.stringify(await blocks());
  if (snap === prev) break;
  prev = snap;
  await p.waitForTimeout(150);
}
await p.waitForTimeout(300);

// Refuse to measure a page that never rendered — see scripts/lib/preflight.mjs for
// why this must run before any measurement, not just at process start.
await assertPageRendered(p, { context: "nav-trace" });

async function trace(label, startSubstr, key, presses) {
  const n = await num(startSubstr);
  await p.evaluate((n) => window.__t.put(n), n);
  await p.waitForTimeout(120);
  const rows = [];
  let prev = await here();
  rows.push(`start  L${prev.line} c${prev.col} «${prev.text}»`);
  for (let i = 0; i < presses; i++) {
    await settle(); // see __t.settle — pins posAtCoords to its precise path
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
