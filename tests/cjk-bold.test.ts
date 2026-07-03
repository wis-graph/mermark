import { describe, it, expect, vi, beforeEach } from "vitest";
import { parser as baseParser, GFM } from "@lezer/markdown";
import { mermarkExtensions } from "../src/markdown/parser";
import {
  isCjk,
  classifyBoldFlank,
  findCjkBoldRuns,
  hasBoldMarker,
  alreadyStyled,
  standardBoldFlank,
} from "../src/markdown/live-preview/features/cjk-bold";

const parser = baseParser.configure([GFM, ...mermarkExtensions]);

describe("isCjk", () => {
  it("is true for Hangul, Han and Kana letters", () => {
    expect(isCjk("를")).toBe(true);
    expect(isCjk("중")).toBe(true);
    expect(isCjk("あ")).toBe(true);
    expect(isCjk("一")).toBe(true);
  });
  it("is false for latin letters, digits, punctuation and space", () => {
    expect(isCjk("a")).toBe(false);
    expect(isCjk("1")).toBe(false);
    expect(isCjk('"')).toBe(false);
    expect(isCjk(")")).toBe(false);
    expect(isCjk(" ")).toBe(false);
  });
});

describe("classifyBoldFlank", () => {
  it("closes when a punctuation-preceded marker is followed by CJK (the rescue case)", () => {
    expect(classifyBoldFlank('"', "를").canClose).toBe(true);
  });
  it("opens when a CJK-preceded marker is followed by punctuation (symmetric open case)", () => {
    expect(classifyBoldFlank("글", '"').canOpen).toBe(true);
  });
  it("does not open a marker followed by a space (latin, unchanged)", () => {
    expect(classifyBoldFlank("d", " ").canOpen).toBe(false);
  });
  it("does not close a marker preceded by a space (latin, unchanged)", () => {
    expect(classifyBoldFlank(" ", "y").canClose).toBe(false);
  });
});

describe("findCjkBoldRuns", () => {
  it("finds the rescue pair in **\"New Policy\"**를", () => {
    const runs = findCjkBoldRuns('**"New Policy"**를');
    expect(runs.length).toBe(1);
    const [r] = runs;
    expect('**"New Policy"**를'.slice(r.openEnd, r.closeStart)).toBe('"New Policy"');
  });

  it("finds the rescue pair for a code-span-flavored punctuation neighbor", () => {
    const doc = "see the **`user_id`**와 done";
    const runs = findCjkBoldRuns(doc);
    expect(runs.length).toBe(1);
    expect(doc.slice(runs[0].openEnd, runs[0].closeStart)).toBe("`user_id`");
  });

  it("finds the symmetric open rescue case: 한글**\"x\"**", () => {
    const runs = findCjkBoldRuns('한글**"x"**');
    expect(runs.length).toBe(1);
  });

  it("returns zero runs for an already-standard pair (**중요**를)", () => {
    expect(findCjkBoldRuns("**중요**를")).toEqual([]);
  });

  it("returns zero runs for plain **bold** (no CJK adjacency)", () => {
    expect(findCjkBoldRuns("**bold**")).toEqual([]);
  });

  it("returns zero runs for latin **x**y (already standard)", () => {
    expect(findCjkBoldRuns("**x**y")).toEqual([]);
  });

  it("finds two non-overlapping runs in consecutive rescue pairs", () => {
    const doc = '**"a"**를**"b"**와';
    const runs = findCjkBoldRuns(doc);
    expect(runs.length).toBe(2);
    expect(runs[0].closeEnd).toBeLessThanOrEqual(runs[1].openStart);
  });

  it("skips an escaped opening marker", () => {
    expect(findCjkBoldRuns('\\**x**를')).toEqual([]);
  });
});

describe("hasBoldMarker", () => {
  it("is false for text with no ** at all (the early-out path)", () => {
    expect(hasBoldMarker("plain text, no markers")).toBe(false);
  });
  it("is true when ** is present", () => {
    expect(hasBoldMarker("a **b** c")).toBe(true);
  });
});

describe("alreadyStyled", () => {
  it("is true inside a parsed StrongEmphasis", () => {
    const doc = "**bold** text";
    const tree = parser.parse(doc);
    expect(alreadyStyled(tree, 2)).toBe(true); // inside "bold"
  });
  it("is true inside inline code", () => {
    const doc = "a `code **not bold**` b";
    const tree = parser.parse(doc);
    const pos = doc.indexOf("not bold");
    expect(alreadyStyled(tree, pos)).toBe(true);
  });
  it("is false in bare unparsed text", () => {
    const doc = '**"New Policy"**를';
    const tree = parser.parse(doc);
    expect(alreadyStyled(tree, 0)).toBe(false);
  });
});

// --- standardBoldFlank ↔ real lezer equivalence trip wire -------------------
//
// docs/reviews/intent-review-2026-07-03.md #3: standardBoldFlank re-implements
// @lezer/markdown's private DefaultInline.Emphasis flanking formula for a
// fixed `**` delimiter. If upstream lezer drifts (gets stricter OR more
// lenient than this reimplementation), findCjkBoldRuns could either
// double-apply cm-strong (guarded at runtime by alreadyStyled — see the
// integration tests above) or silently miss a legitimate CJK rescue (NOT
// guarded anywhere before this test existed). This matrix makes both
// directions of drift fail loudly: for every (before, after) neighbor-class
// pair in a standard (non-CJK) boundary corpus, standardBoldFlank's verdict
// must match whether the real baseParser+GFM parser actually produces a
// StrongEmphasis node for the equivalent document.
//
// Each probe isolates ONE side of the `**` pair (open or close) by pinning
// the OTHER side to a construction that is unconditionally flanking-valid
// under the standard formula, regardless of the neighbor class under test —
// see the inline comments on eachConstruction for the pinning proof.

type NeighborClass = "letter" | "digit" | "punct" | "space" | "boundary";

// One representative character per class. "boundary" = start-of-paragraph
// (for the open probe) or end-of-paragraph (for the close probe) — modeled
// as "" (isSpace("") is true in cjk-bold.ts, matching CommonMark's
// start/end-of-line-is-whitespace-equivalent convention).
const NEIGHBORS: Record<NeighborClass, string> = {
  letter: "a",
  digit: "5",
  punct: '"',
  space: " ",
  boundary: "",
};
const CLASSES = Object.keys(NEIGHBORS) as NeighborClass[];

function hasStrongEmphasis(doc: string): boolean {
  const tree = parser.parse(doc);
  let found = false;
  tree.iterate({
    enter(node) {
      if (node.name === "StrongEmphasis") found = true;
    },
  });
  return found;
}

describe("standardBoldFlank <-> real lezer StrongEmphasis: bidirectional equivalence matrix", () => {
  describe("canOpen (opening ** flanking)", () => {
    // Pin the CLOSE side: content is "${after}Z" and the closer follows
    // immediately, so beforeClose is always 'Z' (a letter) -> rightFlanking
    // is true regardless of afterClose ("" here, doc ends at the closer).
    // Only the OPEN side's (before, after) pair is under test.
    for (const beforeClass of CLASSES) {
      for (const afterClass of CLASSES) {
        if (afterClass === "boundary") continue; // open marker always has content right after it
        const before = NEIGHBORS[beforeClass];
        const after = NEIGHBORS[afterClass];
        it(`before=${beforeClass} after=${afterClass}`, () => {
          const doc = beforeClass === "boundary" ? `**${after}Z**` : `x${before}**${after}Z**`;
          expect(hasStrongEmphasis(doc)).toBe(standardBoldFlank(before, after).canOpen);
        });
      }
    }
  });

  describe("canClose (closing ** flanking)", () => {
    // Pin the OPEN side: the opener sits at the absolute start of the
    // paragraph (before="" -> sBefore=true) and is immediately followed by
    // 'Z' (a letter -> sAfter=false, pAfter=false), so leftFlanking is true
    // regardless of before/afterClass. Only the CLOSE side's (before, after)
    // pair is under test.
    for (const beforeClass of CLASSES) {
      if (beforeClass === "boundary") continue; // close marker always has content right before it
      for (const afterClass of CLASSES) {
        const before = NEIGHBORS[beforeClass];
        const after = NEIGHBORS[afterClass];
        it(`before=${beforeClass} after=${afterClass}`, () => {
          const doc = afterClass === "boundary" ? `**Z${before}**` : `**Z${before}**${after}y`;
          expect(hasStrongEmphasis(doc)).toBe(standardBoldFlank(before, after).canClose);
        });
      }
    }
  });
});

// --- Decoration integration (mounted editor) --------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "read_file"
      ? Promise.resolve({ text: "", mtime: 1 })
      : cmd === "write_file"
        ? Promise.resolve(1)
        : Promise.resolve(false),
  ),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

// Static import after the mock is declared (vi.mock is hoisted by vitest).
import { mountEditor } from "../src/editor";

function mount(host: HTMLElement, doc: string) {
  return mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
}

describe("cjkBold decoration integration", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("styles the rescue pair as cm-strong and conceals its ** markers", () => {
    const doc = 'first line\n\nsee **"New Policy"**를 here';
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-strong")).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain('**"New Policy"**');
    expect(view.contentDOM.textContent).toContain("New Policy");
    expect(view.contentDOM.textContent).toContain("를");
    view.destroy();
  });

  it("does not double-apply cm-strong to an already-standard pair (**중요**를)", () => {
    const doc = "그건 **중요**를 뜻한다";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelectorAll(".cm-strong").length).toBe(1);
    view.destroy();
  });

  it("leaves standard **bold** and _em_ untouched", () => {
    const doc = "**bold** and _em_ text";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelectorAll(".cm-strong").length).toBe(1);
    expect(view.contentDOM.querySelector(".cm-em")).not.toBeNull();
    expect(view.contentDOM.textContent).toContain("bold");
    expect(view.contentDOM.textContent).toContain("em");
    view.destroy();
  });

  it("leaves the space-separated standard case untouched: **\"quote\"** 를", () => {
    const doc = '**"quote"** 를 here';
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelectorAll(".cm-strong").length).toBe(1);
    view.destroy();
  });
});
