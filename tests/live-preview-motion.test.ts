import { describe, it, expect } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { modeFacet, pickBlockLanding } from "../src/markdown/live-preview/core";
import type { BlockSpec } from "../src/markdown/live-preview/core";

// pickBlockLanding is the PURE decision behind vertical block-entry: given the
// caret head and CM's geometric target head (which leaps over atomic block
// widgets), it returns the offset the caret should snap to so the block reveals
// — or null to let default motion run. No layout needed, so it's unit-testable.

const DOC = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

function stateAt(head: number, mode: "edit" | "read" = "edit", ext: Extension[] = []) {
  return EditorState.create({ doc: DOC, selection: { anchor: head }, extensions: [modeFacet.of(mode), ...ext] });
}
// helper: offset of the start of line n (1-based)
function lf(n: number) {
  return EditorState.create({ doc: DOC }).doc.line(n).from;
}
function lend(n: number) {
  return EditorState.create({ doc: DOC }).doc.line(n).to;
}
const block = (fromLine: number, toLine: number): BlockSpec => ({
  kind: "test",
  from: lf(fromLine),
  to: lend(toLine),
  src: "",
  widget: (() => undefined) as unknown as BlockSpec["widget"],
});

const A = block(3, 4); // block on lines 3-4
const B = block(7, 8); // block on lines 7-8

describe("pickBlockLanding", () => {
  it("down: catches a block across a blank line (geometric leap) → block.from", () => {
    // caret on L1, geometric target leaps to L12 (skipping the atomic block)
    const s = stateAt(lf(1));
    expect(pickBlockLanding(s, lf(1), lf(12), 1, [A, B])).toBe(A.from);
  });

  it("down: whole-widget leap pulls the caret back onto the nearest block", () => {
    const s = stateAt(lf(2));
    // target landed on the text line below block A
    expect(pickBlockLanding(s, lf(2), lf(5), 1, [A])).toBe(A.from);
  });

  it("up: lands on the NEAREST block above (last source line), not the farthest", () => {
    const s = stateAt(lf(12));
    // up move leaps from L12 past both blocks to L1; nearest above is B → its last line (L8)
    expect(pickBlockLanding(s, lf(12), lf(1), -1, [A, B])).toBe(lf(8));
  });

  it("returns null for a pure text move (no block crossed) → default motion runs", () => {
    const s = stateAt(lf(1));
    expect(pickBlockLanding(s, lf(1), lf(2), 1, [A, B])).toBeNull();
  });

  it("excludes a block the caret already touches (revealed) so the caret walks out", () => {
    // caret sits on the block's first line → revealed → not a landing candidate
    const s = stateAt(A.from);
    expect(pickBlockLanding(s, A.from, lf(5), 1, [A])).toBeNull();
  });

  it("returns null in read mode (revealed() is false but motion shouldn't hijack via this path)", () => {
    // read mode: reveal never happens, so even an un-touched block is... still a
    // candidate here (pickBlockLanding doesn't gate mode; moveOrEnter does). But a
    // read-mode state where the caret is ON the block line is NOT revealed (read),
    // so the block would be picked. Guard lives in moveOrEnter, not here — assert
    // the pure function's contract: it only filters by revealed(), which is false
    // in read mode, so the block IS returned.
    const s = stateAt(lf(1), "read");
    expect(pickBlockLanding(s, lf(1), lf(5), 1, [A])).toBe(A.from);
  });

  it("single-line block: enters from below (up), then null once on it", () => {
    const C = block(5, 5); // single-line block on L5
    const below = stateAt(lf(6));
    expect(pickBlockLanding(below, lf(6), lf(4), -1, [C])).toBe(lf(5));
    const on = stateAt(lf(5));
    expect(pickBlockLanding(on, lf(5), lf(4), -1, [C])).toBeNull(); // revealed → excluded
  });

  it("stacked blocks: down picks the upper, up picks the lower", () => {
    const s = stateAt(lf(1));
    expect(pickBlockLanding(s, lf(1), lf(12), 1, [A, B])).toBe(A.from); // upper first going down
    const s2 = stateAt(lf(12));
    expect(pickBlockLanding(s2, lf(12), lf(1), -1, [A, B])).toBe(lf(8)); // lower (B) first going up
  });
});
