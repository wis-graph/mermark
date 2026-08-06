import { describe, it, expect, vi, beforeEach } from "vitest";
import { parser as baseParser, GFM } from "@lezer/markdown";
import { mermarkExtensions } from "../src/markdown/parser";
import {
  isCjk,
  classifyEmphasisFlank,
  standardEmphasisFlank,
  scanDelimiterRuns,
  runKind,
  findCjkEmphasisRuns,
  hasEmphasisMarker,
  alreadyStyled,
} from "../src/markdown/live-preview/features/cjk-emphasis";

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

describe("classifyEmphasisFlank", () => {
  it("closes when a punctuation-preceded marker is followed by CJK (the rescue case)", () => {
    expect(classifyEmphasisFlank('"', "를").canClose).toBe(true);
  });
  it("opens when a CJK-preceded marker is followed by punctuation (symmetric open case)", () => {
    expect(classifyEmphasisFlank("글", '"').canOpen).toBe(true);
  });
  it("does not open a marker followed by a space (latin, unchanged)", () => {
    expect(classifyEmphasisFlank("d", " ").canOpen).toBe(false);
  });
  it("does not close a marker preceded by a space (latin, unchanged)", () => {
    expect(classifyEmphasisFlank(" ", "y").canClose).toBe(false);
  });
});

// --- scanDelimiterRuns / runKind ---------------------------------------------

describe("scanDelimiterRuns", () => {
  it("extracts maximal * runs with accurate lengths and positions", () => {
    const text = '*"a **b**"*라';
    //            0123456789...
    // 0:*  1:"  2:a  3:sp  4:*  5:*  6:b  7:*  8:*  9:"  10:*  11:라
    const runs = scanDelimiterRuns(text);
    expect(runs.map((r) => r.length)).toEqual([1, 2, 2, 1]);
    expect(runs[0]).toMatchObject({ start: 0, end: 1 });
    expect(runs[1]).toMatchObject({ start: 4, end: 6 });
    expect(runs[2]).toMatchObject({ start: 7, end: 9 });
    expect(runs[3]).toMatchObject({ start: 10, end: 11 });
  });

  it("does not treat an escaped * as (part of) a run", () => {
    const text = "\\*x*를";
    // 0:\  1:*(escaped)  2:x  3:*  4:를
    const runs = scanDelimiterRuns(text);
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({ start: 3, end: 4, length: 1 });
  });

  it("extracts runs on both sides of a newline as separate runs", () => {
    const text = "a*b\nc*d";
    // 0:a 1:* 2:b 3:\n 4:c 5:* 6:d
    const runs = scanDelimiterRuns(text);
    expect(runs.length).toBe(2);
    expect(runs[0]).toMatchObject({ start: 1, end: 2 });
    expect(runs[1]).toMatchObject({ start: 5, end: 6 });
  });

  it("extracts a length-3 run as a single run, not two", () => {
    const runs = scanDelimiterRuns("가***나***다");
    expect(runs.map((r) => r.length)).toEqual([3, 3]);
  });
});

describe("runKind", () => {
  it("length 1 -> em, length 2 -> strong, length 3 -> both, length >= 4 -> null (non-target)", () => {
    expect(runKind(1)).toBe("em");
    expect(runKind(2)).toBe("strong");
    expect(runKind(3)).toBe("both");
    expect(runKind(4)).toBeNull();
    expect(runKind(5)).toBeNull();
  });
});

// --- findCjkEmphasisRuns ------------------------------------------------------

describe("findCjkEmphasisRuns", () => {
  it("[회귀-보고원문] rescues the outer italic wrapping an already-standard inner bold", () => {
    const doc =
      '본문은 왼쪽 무리에 대해 *"동물-되기와 **같은 방식으로 이해될 수 있는 측면이 강합니다**"*라';
    const runs = findCjkEmphasisRuns(doc);
    const emRuns = runs.filter((r) => r.kind === "em");
    const strongRuns = runs.filter((r) => r.kind === "strong");
    expect(emRuns.length).toBe(1);
    expect(strongRuns.length).toBe(0); // inner ** is already std StrongEmphasis, not a rescue
    expect(doc.slice(emRuns[0].openEnd, emRuns[0].closeStart)).toBe(
      '"동물-되기와 **같은 방식으로 이해될 수 있는 측면이 강합니다**"',
    );
  });

  it("rescues a standalone italic: 그 *\"강조\"*라 부분", () => {
    const runs = findCjkEmphasisRuns('그 *"강조"*라 부분');
    expect(runs.length).toBe(1);
    expect(runs[0].kind).toBe("em");
  });

  it('rescues only the outer em when the inner ** is already standard: *"a **b**"*라', () => {
    const runs = findCjkEmphasisRuns('*"a **b**"*라');
    expect(runs.filter((r) => r.kind === "em").length).toBe(1);
    expect(runs.filter((r) => r.kind === "strong").length).toBe(0);
  });

  it('preserves the existing ** rescue with a std inner *: **"a *b*"**라', () => {
    const runs = findCjkEmphasisRuns('**"a *b*"**라');
    expect(runs.filter((r) => r.kind === "strong").length).toBe(1);
    expect(runs.filter((r) => r.kind === "em").length).toBe(0);
  });

  it('rescues both outer strong and inner em in double-rescue nesting: *"가 **"나"**라 다"*요', () => {
    const runs = findCjkEmphasisRuns('*"가 **"나"**라 다"*요');
    expect(runs.filter((r) => r.kind === "strong").length).toBe(1);
    expect(runs.filter((r) => r.kind === "em").length).toBe(1);
  });

  it("returns [] when std already resolves it (이것은 *중요*를 뜻한다)", () => {
    expect(findCjkEmphasisRuns("이것은 *중요*를 뜻한다")).toEqual([]);
  });

  it("returns [] for arithmetic * with spaces on both sides (no false positive)", () => {
    expect(findCjkEmphasisRuns("값은 2 * 3 그리고 4 * 5 이다")).toEqual([]);
  });

  it("returns [] for intraword * (std already produces Emphasis)", () => {
    expect(findCjkEmphasisRuns("가*나 다*라")).toEqual([]);
  });

  it("returns [] for 가***나***다 — intraword *** that the real parser already resolves (Emphasis>StrongEmphasis), not a rescue", () => {
    // 2026-08-07 measured: real parser (baseParser+GFM) already nests
    // Emphasis(1-8) > StrongEmphasis(2-7) for this input. runKind(3) is
    // "both" now (not null), so this pair DOES enter the "both" candidate
    // list — but std flanking resolves it (before/after are plain CJK
    // letters, not punctuation, so the whole-run canOpen/canClose formula
    // succeeds regardless of adjacency), so rescuedSolelyByCjkRelaxation is
    // false and it's correctly left untouched.
    expect(findCjkEmphasisRuns("가***나***다")).toEqual([]);
  });

  it("does not scan a list bullet's leading * (structurally outside Paragraph)", () => {
    expect(findCjkEmphasisRuns("* 항목")).toEqual([]);
  });

  // --- *** (bold-italic) — 2026-08-07 실측 (probe against baseParser+GFM,
  // recorded in _workspace/02_frontend_changes.md "재호출 2차"):
  //
  //   그는 ***매우 중요한*** 말을 했다        -> Emphasis>StrongEmphasis (std OK)
  //   그는 ***매우 중요한***이라고 했다        -> Emphasis>StrongEmphasis (std OK,
  //                                              because the char right before
  //                                              the closing run is '한' — a
  //                                              plain letter, not punctuation —
  //                                              so canClose's OR-branch is
  //                                              satisfied before the CJK char
  //                                              after the run even matters)
  //   ***"강조"***를                          -> NO node at all (std fails: the
  //                                              char before the closing run
  //                                              IS punctuation ("), so canClose
  //                                              needs sAfter||pAfter and 를
  //                                              satisfies neither under std)
  //   가***나***다                            -> Emphasis>StrongEmphasis (std OK)
  //
  // Conclusion: the CJK-flanking bug only bites `***` in the same shape it
  // already bites `*`/`**` — punctuation immediately before the closing run
  // AND a CJK letter immediately after it. Plain CJK adjacency alone (no
  // intervening punctuation) is NOT broken; the real parser's rule-of-3
  // splitting already handles it. These next two lock the "already works,
  // leave alone" half of that line before the rescue tests lock the other.

  it("[***-실측] leaves the already-working latin-space case untouched: 그는 ***매우 중요한*** 말을 했다", () => {
    expect(findCjkEmphasisRuns("그는 ***매우 중요한*** 말을 했다")).toEqual([]);
  });

  it("[***-실측] leaves the already-working CJK-adjacent case untouched (no intervening punctuation): 그는 ***매우 중요한***이라고 했다", () => {
    expect(findCjkEmphasisRuns("그는 ***매우 중요한***이라고 했다")).toEqual([]);
  });

  it('[***-신규] rescues the CJK-flanking failure that mirrors the ** and * bugs: ***"강조"***를', () => {
    const runs = findCjkEmphasisRuns('***"강조"***를');
    expect(runs.length).toBe(1);
    expect(runs[0].kind).toBe("both");
    expect('***"강조"***를'.slice(runs[0].openEnd, runs[0].closeStart)).toBe('"강조"');
  });

  it("does not let em/strong/both candidates interfere across kinds in one paragraph", () => {
    // 이탤릭(std, 그대로) + 볼드(std, 그대로) + 볼드이탤릭 rescue, 한 문장에.
    const doc = '가*나 와 **다** 와 ***"라"***를 함께 본다';
    const runs = findCjkEmphasisRuns(doc);
    // 가*나: std already resolves it (intraword) — not a rescue.
    // **다**: plain latin/CJK-letter neighbors — std already resolves — not a rescue.
    // ***"라"***를: the only rescue — same shape as the case above.
    expect(runs.length).toBe(1);
    expect(runs[0].kind).toBe("both");
    expect(doc.slice(runs[0].openEnd, runs[0].closeStart)).toBe('"라"');
  });

  // --- existing ** (strong) cases, preserved with an explicit kind assertion ---

  it('still finds the ** rescue pair in **"New Policy"**를', () => {
    const runs = findCjkEmphasisRuns('**"New Policy"**를');
    expect(runs.length).toBe(1);
    expect(runs[0].kind).toBe("strong");
    expect('**"New Policy"**를'.slice(runs[0].openEnd, runs[0].closeStart)).toBe('"New Policy"');
  });

  it("finds the ** rescue pair for a code-span-flavored punctuation neighbor", () => {
    const doc = "see the **`user_id`**와 done";
    const runs = findCjkEmphasisRuns(doc);
    expect(runs.length).toBe(1);
    expect(runs[0].kind).toBe("strong");
    expect(doc.slice(runs[0].openEnd, runs[0].closeStart)).toBe("`user_id`");
  });

  it('finds the symmetric ** open rescue case: 한글**"x"**', () => {
    const runs = findCjkEmphasisRuns('한글**"x"**');
    expect(runs.length).toBe(1);
    expect(runs[0].kind).toBe("strong");
  });

  it("returns zero ** runs for an already-standard pair (**중요**를)", () => {
    expect(findCjkEmphasisRuns("**중요**를")).toEqual([]);
  });

  it("returns zero runs for plain **bold** (no CJK adjacency)", () => {
    expect(findCjkEmphasisRuns("**bold**")).toEqual([]);
  });

  it("returns zero runs for latin **x**y (already standard)", () => {
    expect(findCjkEmphasisRuns("**x**y")).toEqual([]);
  });

  it("finds two non-overlapping ** runs in consecutive rescue pairs", () => {
    const doc = '**"a"**를**"b"**와';
    const runs = findCjkEmphasisRuns(doc);
    expect(runs.length).toBe(2);
    expect(runs[0].closeEnd).toBeLessThanOrEqual(runs[1].openStart);
  });

  it("skips an escaped ** opening marker", () => {
    expect(findCjkEmphasisRuns('\\**x**를')).toEqual([]);
  });

  // --- 2026-08-07 audit 🟡1: isClaimedByOther drops a run from the
  // candidate pool *before* pairing, so it can't phantom-pair with (and
  // consume) a legitimate neighbor. Pure-function level, no tree involved.

  it("[audit-🟡1 pure repro] without a predicate, a raw * phantom-pairs and starves the real pair after it", () => {
    // Reproduces the audit's exact input at the pure-function level (no
    // tree — this is what a bare re-scan of the text sees, ignoring that the
    // first "*" sits inside a code span). The default predicate ("nothing is
    // claimed") lets that code-span "*" phantom-pair with the REAL opener
    // (consuming it), leaving the real closer with no partner — the rescue
    // for "강조" never happens even though its own flanking is fine.
    const doc = '코드 `가*"나"` 그*"강조"*를 본다';
    const emRuns = findCjkEmphasisRuns(doc).filter((r) => r.kind === "em");
    expect(emRuns.length).toBe(1);
    // The one em rescue found is the PHANTOM pair (code-span * .. real
    // opener *), not the real "강조" pair — direct evidence of starvation.
    expect(doc.slice(emRuns[0].openStart, emRuns[0].openEnd)).toBe("*");
    expect(doc.slice(emRuns[0].openEnd, emRuns[0].closeStart)).not.toBe('"강조"');
  });

  it("[audit-🟡1 pure repro] isClaimedByOther drops the code-span * before pairing, restoring the real rescue", () => {
    const doc = '코드 `가*"나"` 그*"강조"*를 본다';
    // Simulate `enter()`'s isClaimedByOther for the position of the * that
    // sits inside the backticks (the first * in the doc).
    const claimedStart = doc.indexOf("*");
    const runs = findCjkEmphasisRuns(doc, (start) => start === claimedStart);
    const emRuns = runs.filter((r) => r.kind === "em");
    expect(emRuns.length).toBe(1);
    expect(doc.slice(emRuns[0].openEnd, emRuns[0].closeStart)).toBe('"강조"');
  });
});

describe("hasEmphasisMarker", () => {
  it("is false for text with no * at all (the early-out path)", () => {
    expect(hasEmphasisMarker("plain text, no markers")).toBe(false);
  });
  it("is true when * is present", () => {
    expect(hasEmphasisMarker("a *b* c")).toBe(true);
  });
  it("is true when ** is present", () => {
    expect(hasEmphasisMarker("a **b** c")).toBe(true);
  });
});

describe("alreadyStyled", () => {
  it("is true inside a parsed StrongEmphasis", () => {
    const doc = "**bold** text";
    const tree = parser.parse(doc);
    expect(alreadyStyled(tree, 2)).toBe(true); // inside "bold"
  });
  it("is true inside a parsed Emphasis", () => {
    const doc = "*em* text";
    const tree = parser.parse(doc);
    expect(alreadyStyled(tree, 1)).toBe(true); // inside "em"
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
  // Highlight/Strikethrough are transparent CONTAINERS (their bodies re-parse
  // recursively), not raw-text territory — a bare `**` inside them still needs
  // the CJK rescue. Regression for the 2026-07-11 report: `==**"따옴표"**입니다==`
  // rendered plain because Highlight sat in STYLED_ANCESTORS and killed the
  // rescue that the identical text outside a highlight received.
  it("is false inside a ==Highlight== body (rescue must reach it)", () => {
    const doc = '앞 ==**"따옴표"**입니다== 뒤';
    const tree = parser.parse(doc);
    expect(alreadyStyled(tree, doc.indexOf("**"))).toBe(false);
  });
  it("is false inside a ~~Strikethrough~~ body", () => {
    const doc = '~~**"따옴표"**입니다~~';
    const tree = parser.parse(doc);
    expect(alreadyStyled(tree, doc.indexOf("**"))).toBe(false);
  });
  it("stays true for inline code nested INSIDE a highlight (raw text wins)", () => {
    const doc = "==a `**code**` b==";
    const tree = parser.parse(doc);
    expect(alreadyStyled(tree, doc.indexOf("**code"))).toBe(true);
  });
});

// --- standardEmphasisFlank ↔ real lezer equivalence trip wire ---------------
//
// docs/reviews/intent-review-2026-07-03.md #3: standardEmphasisFlank
// re-implements @lezer/markdown's private DefaultInline.Emphasis flanking
// formula. This matrix now covers BOTH delimiter lengths lezer treats
// identically for next==42 (`*`): `**` (StrongEmphasis) and `*` (Emphasis).
// If upstream lezer drifts (stricter OR more lenient), findCjkEmphasisRuns
// could either double-apply a rescue (guarded at runtime by alreadyStyled —
// see the integration tests below) or silently miss a legitimate rescue (NOT
// guarded anywhere before this test existed). This matrix makes both
// directions of drift fail loudly.
//
// Each probe isolates ONE side of the delimiter pair (open or close) by
// pinning the OTHER side to a construction that is unconditionally
// flanking-valid under the standard formula, regardless of the neighbor
// class under test.

type NeighborClass = "letter" | "digit" | "punct" | "space" | "boundary";

// One representative character per class. "boundary" = start-of-paragraph
// (for the open probe) or end-of-paragraph (for the close probe) — modeled
// as "" (isSpace("") is true in cjk-emphasis.ts, matching CommonMark's
// start/end-of-line-is-whitespace-equivalent convention).
const NEIGHBORS: Record<NeighborClass, string> = {
  letter: "a",
  digit: "5",
  punct: '"',
  space: " ",
  boundary: "",
};
const CLASSES = Object.keys(NEIGHBORS) as NeighborClass[];

function hasNode(doc: string, name: string): boolean {
  const tree = parser.parse(doc);
  let found = false;
  tree.iterate({
    enter(node) {
      if (node.name === name) found = true;
    },
  });
  return found;
}

describe("standardEmphasisFlank <-> real lezer StrongEmphasis (**): bidirectional equivalence matrix", () => {
  describe("canOpen (opening ** flanking)", () => {
    for (const beforeClass of CLASSES) {
      for (const afterClass of CLASSES) {
        if (afterClass === "boundary") continue; // open marker always has content right after it
        const before = NEIGHBORS[beforeClass];
        const after = NEIGHBORS[afterClass];
        it(`before=${beforeClass} after=${afterClass}`, () => {
          const doc = beforeClass === "boundary" ? `**${after}Z**` : `x${before}**${after}Z**`;
          expect(hasNode(doc, "StrongEmphasis")).toBe(standardEmphasisFlank(before, after).canOpen);
        });
      }
    }
  });

  describe("canClose (closing ** flanking)", () => {
    for (const beforeClass of CLASSES) {
      if (beforeClass === "boundary") continue; // close marker always has content right before it
      for (const afterClass of CLASSES) {
        const before = NEIGHBORS[beforeClass];
        const after = NEIGHBORS[afterClass];
        it(`before=${beforeClass} after=${afterClass}`, () => {
          const doc = afterClass === "boundary" ? `**Z${before}**` : `**Z${before}**${after}y`;
          expect(hasNode(doc, "StrongEmphasis")).toBe(standardEmphasisFlank(before, after).canClose);
        });
      }
    }
  });
});

describe("standardEmphasisFlank <-> real lezer Emphasis (*): bidirectional equivalence matrix", () => {
  describe("canOpen (opening * flanking)", () => {
    for (const beforeClass of CLASSES) {
      for (const afterClass of CLASSES) {
        if (afterClass === "boundary") continue;
        const before = NEIGHBORS[beforeClass];
        const after = NEIGHBORS[afterClass];
        it(`before=${beforeClass} after=${afterClass}`, () => {
          const doc = beforeClass === "boundary" ? `*${after}Z*` : `x${before}*${after}Z*`;
          expect(hasNode(doc, "Emphasis")).toBe(standardEmphasisFlank(before, after).canOpen);
        });
      }
    }
  });

  describe("canClose (closing * flanking)", () => {
    for (const beforeClass of CLASSES) {
      if (beforeClass === "boundary") continue;
      for (const afterClass of CLASSES) {
        const before = NEIGHBORS[beforeClass];
        const after = NEIGHBORS[afterClass];
        it(`before=${beforeClass} after=${afterClass}`, () => {
          const doc = afterClass === "boundary" ? `*Z${before}*` : `*Z${before}*${after}y`;
          expect(hasNode(doc, "Emphasis")).toBe(standardEmphasisFlank(before, after).canClose);
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

describe("cjkEmphasis decoration integration", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("[회귀-보고원문] rescues the outer italic around an already-standard inner bold", () => {
    const doc =
      '첫줄\n\n본문은 왼쪽 무리에 대해 *"동물-되기와 **같은 방식으로 이해될 수 있는 측면이 강합니다**"*라';
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } }); // cursor on an unrelated line
    (view as unknown as { measure(): void }).measure();
    const em = view.contentDOM.querySelector(".cm-em");
    const strong = view.contentDOM.querySelector(".cm-strong");
    expect(em).not.toBeNull();
    expect(strong).not.toBeNull();
    expect(em?.contains(strong)).toBe(true); // strong nested inside em
    expect(view.contentDOM.textContent).not.toMatch(/\*/); // no raw * left anywhere
    expect(view.contentDOM.textContent).toContain("동물-되기와");
    expect(view.contentDOM.textContent).toContain("라");
    view.destroy();
  });

  it("[방향2 잠금] preserves the existing **-outer/*-inner rescue: 그는 **\"이것이 *바로* 그 답이다\"**라 말했다", () => {
    const doc = '첫줄\n\n그는 **"이것이 *바로* 그 답이다"**라 말했다';
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelectorAll(".cm-strong").length).toBe(1);
    expect(view.contentDOM.querySelectorAll(".cm-em").length).toBe(1);
    view.destroy();
  });

  it("rescues both sides of a double-rescue nest: *\"가 **\"나\"**라 다\"*요", () => {
    const doc = '첫줄\n\n*"가 **"나"**라 다"*요';
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelectorAll(".cm-strong").length).toBe(1);
    expect(view.contentDOM.querySelectorAll(".cm-em").length).toBe(1);
    view.destroy();
  });

  it("reveals raw markers on the cursor's line, re-conceals off it (report sentence)", () => {
    const doc =
      '첫줄\n\n본문은 왼쪽 무리에 대해 *"동물-되기와 **같은 방식으로 이해될 수 있는 측면이 강합니다**"*라';
    const view = mount(host, doc);
    const targetLine = doc.indexOf("본문은");
    // off-line: concealed
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).not.toMatch(/\*/);
    // cursor onto the target line: revealed (both outer * and inner ** raw)
    view.dispatch({ selection: { anchor: targetLine } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).toContain(
      '*"동물-되기와 **같은 방식으로 이해될 수 있는 측면이 강합니다**"*',
    );
    // cursor away again: re-concealed
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).not.toMatch(/\*/);
    view.destroy();
  });

  it("does not scan list bullets (bullet * stays untouched, no stray cm-em)", () => {
    const doc = "* 항목 하나\n* 항목 둘";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelectorAll(".cm-em").length).toBe(0);
    view.destroy();
  });

  // --- 2026-08-07 audit 🟡1: a `*` inside another feature's territory must
  // not phantom-pair and starve a legitimate rescue later on the same line.

  it("[audit-🟡1] a code-span * does not starve the real rescue after it", () => {
    const doc = '첫줄\n\n코드 `가*"나"` 그*"강조"*를 본다';
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelectorAll(".cm-em").length).toBe(1);
    expect(view.contentDOM.textContent).toContain("강조");
    view.destroy();
  });

  it("[audit-🟡1] an inline-math * does not starve the real rescue after it", () => {
    const doc = '첫줄\n\n수식 $가*"나"$ 그*"강조"*를 본다';
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelectorAll(".cm-em").length).toBe(1);
    expect(view.contentDOM.textContent).toContain("강조");
    view.destroy();
  });

  // --- 2026-08-07 audit 🟡2: Comment/CommentBlock must stay raw-text
  // territory — the rescue must never conceal a * marker inside <!-- … -->,
  // which would delete characters from text that text-styles.ts's contract
  // promises to always show verbatim.

  it("[audit-🟡2] does not rescue inside an inline HTML comment (raw text preserved)", () => {
    const doc = '첫줄\n\n앞 <!-- 그*"강조"*를 --> 뒤';
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).toContain('그*"강조"*를');
    expect(view.contentDOM.querySelector(".cm-comment .cm-em")).toBeNull();
    view.destroy();
  });

  // --- 2026-08-07 재호출 2차: *** (bold-italic). 실측(위 findCjkEmphasisRuns
  // describe의 "[***-실측]"/"[***-신규]" 주석)을 마운트 레벨에서도 잠근다.

  it("[***-실측] leaves the already-working *** untouched at the DOM level (no cm-em/.cm-strong from this feature; the parser's own nodes render instead)", () => {
    const doc = "첫줄\n\n그는 ***매우 중요한*** 말을 했다";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    // The real parser already made Emphasis>StrongEmphasis for this (see
    // text-styles.ts), so text-styles renders it — cjkEmphasis contributes
    // nothing here. Assert only what THIS feature promises: raw source
    // intact (no marker deleted by a phantom rescue) and content preserved.
    expect(view.contentDOM.textContent).not.toContain("***매우 중요한***");
    expect(view.contentDOM.textContent).toContain("매우 중요한");
    view.destroy();
  });

  it('[***-신규] rescues ***"강조"***를: both cm-em and cm-strong on the body, all six * markers concealed', () => {
    const doc = '첫줄\n\n***"강조"***를 본다';
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    const rescued = view.contentDOM.querySelector(".cm-em.cm-strong");
    expect(rescued).not.toBeNull();
    expect(rescued?.textContent).toBe('"강조"');
    expect(view.contentDOM.textContent).not.toMatch(/\*/);
    expect(view.contentDOM.textContent).toContain("강조");
    expect(view.contentDOM.textContent).toContain("를");
    view.destroy();
  });

  it('[***-신규] reveals all three-star markers on the cursor line, re-conceals off it', () => {
    const doc = '첫줄\n\n***"강조"***를 본다';
    const view = mount(host, doc);
    const targetLine = doc.indexOf('"강조"');
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).not.toMatch(/\*/);
    view.dispatch({ selection: { anchor: targetLine } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).toContain('***"강조"***를');
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).not.toMatch(/\*/);
    view.destroy();
  });

  it("[***-신규] does not interfere with a real em/strong elsewhere in the same paragraph", () => {
    // *중요*/**다**: known-good std patterns (same shape as the existing
    // "이것은 *중요*를 뜻한다" / "그건 **중요**를 뜻한다" tests above — std
    // already resolves both, so the REAL parser makes Emphasis/StrongEmphasis
    // here, not this feature).
    const doc = '첫줄\n\n이것은 *중요*를 그리고 **다**도 그리고 ***"라"***도 함께 본다';
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    // *중요*/**다**: real parser's own Emphasis/StrongEmphasis — this feature
    // must leave them alone, not double-apply.
    expect(view.contentDOM.querySelectorAll(".cm-em:not(.cm-strong)").length).toBe(1); // *중요*
    expect(view.contentDOM.querySelectorAll(".cm-strong:not(.cm-em)").length).toBe(1); // **다**
    // ***"라"***: the one rescue, both classes on the same node.
    expect(view.contentDOM.querySelectorAll(".cm-em.cm-strong").length).toBe(1);
    view.destroy();
  });

  it("styles the ** rescue pair as cm-strong and conceals its ** markers", () => {
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
