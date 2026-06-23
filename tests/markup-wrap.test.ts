import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { buildMarkupWrap } from "../src/markdown/markup-wrap";

/** Apply buildMarkupWrap for `ch` to a doc + single selection, return the new
 *  doc and main range — or null when nothing happens (no selection / bad key). */
function press(doc: string, anchor: number, head: number, ch: string) {
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  const spec = buildMarkupWrap(state, ch);
  if (spec === null) return null;
  const next = state.update(spec).state;
  return { doc: next.doc.toString(), from: next.selection.main.from, to: next.selection.main.to };
}

/** Repeatedly press `ch`, re-selecting the returned inner range each time, to
 *  model a user pressing the key several times in a row over the same word. */
function pressN(doc: string, anchor: number, head: number, ch: string, times: number) {
  let cur = press(doc, anchor, head, ch)!;
  for (let i = 1; i < times; i++) cur = press(cur.doc, cur.from, cur.to, ch)!;
  return cur;
}

describe("markup-wrap: `=` toggles highlight", () => {
  it("one press wraps the selection in == and keeps the inner selected", () => {
    const r = press("foo bar baz", 4, 7, "="); // select "bar"
    expect(r?.doc).toBe("foo ==bar== baz");
    expect([r?.from, r?.to]).toEqual([6, 9]);
  });

  it("a second press (inner still selected) toggles the highlight back off", () => {
    const r = pressN("foo bar baz", 4, 7, "=", 2);
    expect(r.doc).toBe("foo bar baz"); // ==bar== → bar
    expect([r.from, r.to]).toEqual([4, 7]);
  });

  it("leaves an empty selection alone so `=` types normally", () => {
    expect(press("a  b", 2, 2, "=")).toBeNull();
  });
});

describe("markup-wrap: `*` cycles emphasis italic → bold → both → none", () => {
  it("press 1 → *italic*", () => {
    expect(press("a foo b", 2, 5, "*")?.doc).toBe("a *foo* b");
  });
  it("press 2 → **bold**", () => {
    expect(pressN("a foo b", 2, 5, "*", 2).doc).toBe("a **foo** b");
  });
  it("press 3 → ***bold-italic***", () => {
    expect(pressN("a foo b", 2, 5, "*", 3).doc).toBe("a ***foo*** b");
  });
  it("press 4 cycles back to plain", () => {
    const r = pressN("a foo b", 2, 5, "*", 4);
    expect(r.doc).toBe("a foo b");
    expect([r.from, r.to]).toEqual([2, 5]);
  });
  it("an empty selection types `*` literally (null), so 2 * 3 is untouched", () => {
    expect(press("2  3", 2, 2, "*")).toBeNull();
  });
});

describe("markup-wrap: misc", () => {
  it("ignores keys that aren't markers", () => {
    expect(press("foo", 0, 3, "x")).toBeNull();
  });

  it("wraps each range of a multi-selection independently", () => {
    const state = EditorState.create({
      doc: "aa bb",
      selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 5)]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    expect(state.update(buildMarkupWrap(state, "=")!).state.doc.toString()).toBe("==aa== ==bb==");
  });
});
