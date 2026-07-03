import { syntaxTree } from "@codemirror/language";
import { Decoration } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { hide, type InlineFeature } from "../core";

// ---------------------------------------------------------------------------
// M7 — CJK-friendly bold. @lezer/markdown's emphasis flanking (index.js
// DefaultInline.Emphasis) classifies CJK letters as plain "letters" — neither
// Punctuation nor whitespace — so `**"New Policy"**를` fails to close: the
// closing `**` is preceded by `"` (punctuation) and followed by `를`, and
// standard flanking only allows that when the char *after* the close is also
// punctuation/whitespace. Overriding the parser is structurally blocked (see
// _workspace/01_architect_design.md §1) — @lezer/markdown builds Emphasis from
// a non-exported DelimiterType singleton and DefaultInline.Emphasis can't be
// replaced via MarkdownConfig. So this feature re-scans the *bare* Paragraph/
// Heading text the parser left unstyled, reproducing the same flanking
// formula but treating adjacent CJK letters as punctuation-like (never as
// whitespace — that would break `**중요**를`, which already succeeds because
// CJK letters aren't whitespace under standard rules either).
//
// `**` bold only (see design §2 — `*`/`***`/`_` are out of scope). Any pair
// the *standard* (non-relaxed) formula already resolves is left alone: the
// real parser already turned it into StrongEmphasis, and `alreadyStyled`
// double-checks against the syntax tree so this feature never double-applies.
// ---------------------------------------------------------------------------

// Same construction lezer's internal (non-exported) `Punctuation` regex uses:
// prefer the Unicode property-escape form, fall back to an explicit class for
// engines without `/u` support.
let PUNCTUATION = /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~\xA1‐-‧]/;
try {
  PUNCTUATION = new RegExp("[\\p{S}|\\p{P}]", "u");
} catch {
  // keep the ASCII-ish fallback above
}

// CJK letters (Hangul syllables + jamo, Han incl. extensions, Hiragana,
// Katakana) plus CJK/fullwidth symbol blocks — design §5's confirmed range.
let CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-힣ힰ-퟿豈-﫿＀-￯　-〿]/;
try {
  CJK = new RegExp(
    "[\\p{Script=Hangul}\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u3000-\\u303F\\uFF00-\\uFFEF]",
    "u",
  );
} catch {
  // keep the explicit-range fallback above
}

/** True for a single CJK letter/symbol (Hangul/Han/Kana + CJK punctuation
 *  blocks) — the set this feature treats "like punctuation" for flanking. */
export function isCjk(ch: string): boolean {
  return ch !== "" && CJK.test(ch);
}

function isPunctuation(ch: string): boolean {
  return ch !== "" && PUNCTUATION.test(ch);
}

function isSpace(ch: string): boolean {
  return ch === "" || /\s/.test(ch);
}

interface Flank {
  canOpen: boolean;
  canClose: boolean;
}

// Reproduces @lezer/markdown's DefaultInline.Emphasis formula (index.js
// ~1451-1464) for a fixed `**` (next==42) delimiter, where `next==42` makes
// `canOpen = leftFlanking` and `canClose = rightFlanking` outright (the
// `!rightFlanking || pBefore` / `!leftFlanking || pAfter` disjuncts are moot
// for `*`). `isPunctLike` decides what counts as "punctuation" for the OR
// branches — the only axis that differs between standard and CJK-relaxed.
function computeFlank(before: string, after: string, isPunctLike: (ch: string) => boolean): Flank {
  const pBefore = isPunctLike(before);
  const pAfter = isPunctLike(after);
  const sBefore = isSpace(before);
  const sAfter = isSpace(after);
  const leftFlanking = !sAfter && (!pAfter || sBefore || pBefore);
  const rightFlanking = !sBefore && (!pBefore || sAfter || pAfter);
  return { canOpen: leftFlanking, canClose: rightFlanking };
}

/** Standard CommonMark flanking — CJK letters are plain letters, exactly what
 *  the real parser already computes. Used to detect "the parser already
 *  handled this pair" so `findCjkBoldRuns` never re-flags it. Exported
 *  (2026-07-03 intent review #3) only so tests/cjk-bold.test.ts can run the
 *  drift trip wire (this formula's canOpen/canClose must agree with the
 *  real @lezer/markdown baseParser's StrongEmphasis judgement) — no
 *  production caller outside this module needs it. */
export function standardBoldFlank(before: string, after: string): Flank {
  return computeFlank(before, after, isPunctuation);
}

/** CJK-relaxed flanking: adjacent CJK letters count as punctuation-like (not
 *  whitespace-like — see module doc for why that distinction matters). */
export function classifyBoldFlank(before: string, after: string): Flank {
  return computeFlank(before, after, (ch) => isPunctuation(ch) || isCjk(ch));
}

/** Cheap early-out: a node with no `**` at all can't contain a CJK-bold run. */
export function hasBoldMarker(text: string): boolean {
  return text.indexOf("**") >= 0;
}

function isEscaped(text: string, idx: number): boolean {
  let backslashes = 0;
  for (let k = idx - 1; k >= 0 && text[k] === "\\"; k--) backslashes++;
  return backslashes % 2 === 1;
}

/** Find the next unescaped `**` at or after `from`, not crossing a newline
 *  (bold never spans lines here — matches the parser's own line discipline). */
function findMarker(text: string, from: number): number {
  for (let j = from; j < text.length - 1; j++) {
    if (text[j] === "\n") return -1;
    if (text[j] === "*" && text[j + 1] === "*" && !isEscaped(text, j)) return j;
  }
  return -1;
}

export interface CjkBoldRun {
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
}

/** Left-to-right, non-nested `**…**` pairing over bare node text. Skips a
 *  pair the *standard* formula already resolves (parser already made it
 *  StrongEmphasis — nothing to rescue) and any pair neither formula resolves
 *  (not bold, CJK-relaxed or not). Only returns pairs that succeed *solely*
 *  because of CJK relaxation — the actual rescue set. */
export function findCjkBoldRuns(text: string): CjkBoldRun[] {
  const runs: CjkBoldRun[] = [];
  let i = 0;
  while (i < text.length - 1) {
    if (text[i] !== "*" || text[i + 1] !== "*" || isEscaped(text, i)) {
      i++;
      continue;
    }
    const openStart = i;
    const openEnd = i + 2;
    const closeStart = findMarker(text, openEnd);
    if (closeStart <= openEnd) {
      // no closer on this line, or empty `****` body — nothing to pair here.
      i = openEnd;
      continue;
    }
    const closeEnd = closeStart + 2;
    const before = openStart > 0 ? text[openStart - 1] : "";
    const afterOpen = text[openEnd] ?? "";
    const beforeClose = text[closeStart - 1] ?? "";
    const after = closeEnd < text.length ? text[closeEnd] : "";

    const std =
      standardBoldFlank(before, afterOpen).canOpen && standardBoldFlank(beforeClose, after).canClose;
    const relaxed =
      classifyBoldFlank(before, afterOpen).canOpen && classifyBoldFlank(beforeClose, after).canClose;

    if (!std && relaxed) runs.push({ openStart, openEnd, closeStart, closeEnd });
    i = closeEnd;
  }
  return runs;
}

// Ancestor node names that mean "this position is already inside a completed
// inline construct" — either the parser already turned this exact `**…**`
// into StrongEmphasis (so re-styling would double-apply), or the position
// lands inside an unrelated inline feature (code/wikilink/math/etc.) whose
// raw text this scan must not touch.
const STYLED_ANCESTORS = new Set([
  "Emphasis",
  "StrongEmphasis",
  "InlineCode",
  "CodeText",
  "FencedCode",
  "Highlight",
  "Strikethrough",
  "InlineMath",
  "Wikilink",
  "WikilinkEmbed",
]);

/** True when `pos` already sits inside a node the real parser/other inline
 *  features own — the guard that stops `cjkBold` from double-applying or
 *  reaching into another feature's territory. */
export function alreadyStyled(tree: Tree, pos: number): boolean {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (STYLED_ANCESTORS.has(n.name)) return true;
  }
  return false;
}

const CLAIMED_NODES = [
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
];

export const cjkBold: InlineFeature = {
  nodes: CLAIMED_NODES,
  enter(node, ctx) {
    const text = ctx.state.sliceDoc(node.from, node.to);
    if (!hasBoldMarker(text)) return; // early-out: no `**` at all → zero cost
    const tree = syntaxTree(ctx.state);
    for (const run of findCjkBoldRuns(text)) {
      const openStart = node.from + run.openStart;
      const openEnd = node.from + run.openEnd;
      const closeStart = node.from + run.closeStart;
      const closeEnd = node.from + run.closeEnd;
      if (alreadyStyled(tree, openStart) || alreadyStyled(tree, closeStart)) continue;
      ctx.push({
        from: openEnd,
        to: closeStart,
        deco: Decoration.mark({ class: "cm-strong" }),
        conceal: false,
      });
      ctx.push({ from: openStart, to: openEnd, deco: hide, conceal: true });
      ctx.push({ from: closeStart, to: closeEnd, deco: hide, conceal: true });
    }
    return; // descend — other inline features still process the same node
  },
};
