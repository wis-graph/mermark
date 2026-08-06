import { syntaxTree } from "@codemirror/language";
import { Decoration } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { hide, type InlineFeature } from "../core";

// ---------------------------------------------------------------------------
// M7/M8 — CJK-friendly emphasis. @lezer/markdown's emphasis flanking
// (index.js DefaultInline.Emphasis) classifies CJK letters as plain
// "letters" — neither Punctuation nor whitespace — so e.g.
// `**"New Policy"**를` fails to close: the closing `**` is preceded by `"`
// (punctuation) and followed by `를`, and standard flanking only allows that
// when the char *after* the close is also punctuation/whitespace. The same
// formula governs single `*` (italic) — `*"동물-되기와 …"*라` fails to close
// for the identical reason. Overriding the parser is structurally blocked
// (see _workspace/01_architect_design.md §1) — @lezer/markdown builds
// Emphasis/StrongEmphasis from a non-exported DelimiterType singleton and
// DefaultInline.Emphasis can't be replaced via MarkdownConfig. So this
// feature re-scans the *bare* Paragraph/Heading text the parser left
// unstyled, reproducing the same flanking formula but treating adjacent CJK
// letters as punctuation-like (never as whitespace — that would break
// `**중요**를`, which already succeeds because CJK letters aren't
// whitespace under standard rules either).
//
// Scope: `*` (em) and `**` (strong) only. Delimiter runs of length >= 3
// (`***`, and longer) are skipped outright — supporting them correctly would
// require reproducing CommonMark's delimiter-splitting ("rule of 3"), which
// this re-scan heuristic doesn't attempt (see design §4). `_`/`__` are also
// out of scope: lezer's `_` path (next==95) carries extra intraword-ban
// flanking conditions that `computeFlank` doesn't model — Korean prose and
// this editor's markup shortcuts use `*`-family delimiters exclusively, so
// there's no reported need. Any pair the *standard* (non-relaxed) formula
// already resolves is left alone: the real parser already turned it into
// Emphasis/StrongEmphasis, and `alreadyStyled` double-checks against the
// syntax tree so this feature never double-applies. Nesting (an outer
// rescued run wrapping an inner parser-made node, or vice versa) needs no
// extra mechanism: CM6 mark decorations nest/overlap freely, and conceal
// ranges for inner vs. outer markers are always disjoint (design §2).
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
// ~1451-1464) for the `next==42` (`*`) delimiter path, where `canOpen =
// leftFlanking` and `canClose = rightFlanking` outright (the `!rightFlanking
// || pBefore` / `!leftFlanking || pAfter` disjuncts are moot for `*`). This
// path is identical for a single `*` and a `**` run — the length only
// decides which CM class the rescue applies (`runKind`), never which
// flanking formula. `isPunctLike` decides what counts as "punctuation" for
// the OR branches — the only axis that differs between standard and
// CJK-relaxed.
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
 *  handled this pair" so `findCjkEmphasisRuns` never re-flags it. Exported
 *  (2026-07-03 intent review #3) only so tests/cjk-emphasis.test.ts can run
 *  the drift trip wire (this formula's canOpen/canClose must agree with the
 *  real @lezer/markdown baseParser's Emphasis/StrongEmphasis judgement) — no
 *  production caller outside this module needs it. */
export function standardEmphasisFlank(before: string, after: string): Flank {
  return computeFlank(before, after, isPunctuation);
}

/** CJK-relaxed flanking: adjacent CJK letters count as punctuation-like (not
 *  whitespace-like — see module doc for why that distinction matters). */
export function classifyEmphasisFlank(before: string, after: string): Flank {
  return computeFlank(before, after, (ch) => isPunctuation(ch) || isCjk(ch));
}

/** Cheap early-out: a node with no `*` at all can't contain a CJK rescue. */
export function hasEmphasisMarker(text: string): boolean {
  return text.indexOf("*") >= 0;
}

function isEscaped(text: string, idx: number): boolean {
  let backslashes = 0;
  for (let k = idx - 1; k >= 0 && text[k] === "\\"; k--) backslashes++;
  return backslashes % 2 === 1;
}

export type DelimiterKind = "em" | "strong";

export interface DelimiterRun {
  start: number;
  end: number;
  length: number;
}

/** "A run's length decides what it could become" — 1 is an em candidate, 2 a
 *  strong candidate, anything else (0 delimiters, or `***`+) is out of scope
 *  (see module doc: rule-of-3 splitting isn't reproduced here). */
export function runKind(length: number): DelimiterKind | null {
  if (length === 1) return "em";
  if (length === 2) return "strong";
  return null;
}

/** Pure query: every maximal run of unescaped `*` in `text`, left to right.
 *  A run never crosses a newline (matches the parser's own line discipline —
 *  emphasis is a single-line construct in this scan). An escaped `*` (odd
 *  number of preceding backslashes) is excluded from every run — it neither
 *  extends a run nor starts one. */
export function scanDelimiterRuns(text: string): DelimiterRun[] {
  const runs: DelimiterRun[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "*" || isEscaped(text, i)) {
      i++;
      continue;
    }
    const start = i;
    let j = i;
    while (j < text.length && text[j] === "*" && !isEscaped(text, j)) j++;
    runs.push({ start, end: j, length: j - start });
    i = j;
  }
  return runs;
}

export interface CjkEmphasisRun {
  kind: DelimiterKind;
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
}

/** `!std && relaxed` — the pair fails standard CommonMark flanking (so the
 *  real parser left it unstyled) but succeeds once CJK letters are treated
 *  as punctuation-like. This is the exact condition under which this
 *  feature's rescue is warranted; anything else (both pass, both fail) is
 *  the parser's territory or genuinely not emphasis, never this feature's. */
export function rescuedSolelyByCjkRelaxation(std: boolean, relaxed: boolean): boolean {
  return !std && relaxed;
}

/** Left-to-right, non-nested pairing of same-`runKind` delimiter runs over
 *  bare node text. For each kind (em: length-1 runs, strong: length-2 runs)
 *  independently: skip a pair the *standard* formula already resolves (the
 *  parser already made it Emphasis/StrongEmphasis — nothing to rescue) and
 *  any pair neither formula resolves (not emphasis, CJK-relaxed or not).
 *  Only returns pairs that succeed *solely* because of CJK relaxation — the
 *  actual rescue set. Runs of length >= 3 (`runKind` returns null) are
 *  skipped entirely, so `가***나***다` — where the old marker-pair scan could
 *  mis-consume the run's first two stars as a `**` open — never produces a
 *  false rescue. Because em and strong runs are scanned from independent
 *  candidate lists, an outer `*…*` and an inner already-standard `**…**` (or
 *  vice versa) never contend for the same delimiter — nesting falls out of
 *  the length partition for free.
 *
 *  `isClaimedByOther(start)` — optional, defaults to "nothing is claimed" —
 *  drops a run from the candidate pool *before* pairing when it isn't. This
 *  keeps the function pure (no tree access; the caller supplies a plain
 *  predicate over text offsets) while closing a starvation bug: a `*` sitting
 *  inside another feature's territory (a code span, inline math, an existing
 *  Emphasis…) used to still enter the left-to-right pairing as a phantom
 *  candidate, and — since a successful pair consumes BOTH its runs — a
 *  phantom opener could pair with the next real run and eat it, starving the
 *  legitimate pair after it. `enter()` passes `alreadyStyled` bound to its
 *  syntax tree; filtering here (pre-pairing) rather than only post-hoc in
 *  `enter()` means a consumed-then-discarded run can no longer starve a real
 *  neighbor (2026-08-07 audit finding — repro: `` 코드 `가*"나"` 그*"강조"*를 본다 ``
 *  produced zero rescues because the code-span `*` phantom-paired with the
 *  real opener and ate it). */
export function findCjkEmphasisRuns(
  text: string,
  isClaimedByOther: (start: number) => boolean = () => false,
): CjkEmphasisRun[] {
  const runs = scanDelimiterRuns(text).filter((run) => !isClaimedByOther(run.start));
  const out: CjkEmphasisRun[] = [];
  const byKind: Record<DelimiterKind, DelimiterRun[]> = { em: [], strong: [] };
  for (const run of runs) {
    const kind = runKind(run.length);
    if (kind) byKind[kind].push(run);
  }

  for (const kind of ["em", "strong"] as const) {
    const candidates = byKind[kind];
    let idx = 0;
    while (idx < candidates.length - 1) {
      const open = candidates[idx];
      const close = candidates[idx + 1];
      const openStart = open.start;
      const openEnd = open.end;
      const closeStart = close.start;
      const closeEnd = close.end;

      if (closeStart <= openEnd || text.slice(openEnd, closeStart).includes("\n")) {
        // Adjacent/empty body (e.g. `****`), or the candidate pair straddles
        // a line break — bold/em never spans lines here. Either way this
        // opener has no valid closer among these candidates; advance past it.
        idx++;
        continue;
      }

      const before = openStart > 0 ? text[openStart - 1] : "";
      const afterOpen = text[openEnd] ?? "";
      const beforeClose = text[closeStart - 1] ?? "";
      const after = closeEnd < text.length ? text[closeEnd] : "";

      const std =
        standardEmphasisFlank(before, afterOpen).canOpen &&
        standardEmphasisFlank(beforeClose, after).canClose;
      const relaxed =
        classifyEmphasisFlank(before, afterOpen).canOpen &&
        classifyEmphasisFlank(beforeClose, after).canClose;

      if (rescuedSolelyByCjkRelaxation(std, relaxed)) {
        out.push({ kind, openStart, openEnd, closeStart, closeEnd });
        idx += 2; // consume both runs — non-nested, left-to-right pairing
      } else {
        idx++;
      }
    }
  }

  // Restore document order across kinds (em/strong runs interleave in text).
  out.sort((a, b) => a.openStart - b.openStart);
  return out;
}

// Ancestor node names that mean "this position is already inside a completed
// inline construct" — either the parser already turned this exact
// `*…*`/`**…**` into Emphasis/StrongEmphasis (so re-styling would
// double-apply), or the position lands inside an unrelated inline feature
// (code/wikilink/math/etc.) whose raw text this scan must not touch.
//
// Highlight / Strikethrough are deliberately NOT in this set (removed
// 2026-07-11): they are transparent CONTAINERS whose bodies the parser
// re-parses recursively — bare `**…**` inside them is exactly as unstyled as
// in a plain paragraph, so the rescue must reach it. With them listed,
// `==**"따옴표"**입니다==` (std flanking fails at the close: punct before,
// CJK after) lost its rescue and rendered plain while the same text outside
// the highlight bolded — the reported bug. The remaining entries are either
// raw-text territory (code/math/wikilink) or the double-apply guard
// (Emphasis/StrongEmphasis: that pair IS already emphasis/bold).
//
// Comment / CommentBlock (`<!-- x -->`) ARE raw-text territory, unlike
// Highlight/Strikethrough: text-styles.ts's contract for them is "always
// show the raw source, never conceal" (`cm-comment` styles the whole node,
// no marker hiding) — they're leaf nodes the parser never re-parses (no
// inner Emphasis/StrongEmphasis inside a comment body). A bare `*` inside a
// comment is therefore never a rescue candidate; without this entry the
// rescue would conceal `*` markers inside `<!-- 그*"강조"*를 -->`, silently
// deleting characters from text that contract promises to show verbatim
// (2026-08-07 audit finding).
const STYLED_ANCESTORS = new Set([
  "Emphasis",
  "StrongEmphasis",
  "InlineCode",
  "CodeText",
  "FencedCode",
  "InlineMath",
  "Wikilink",
  "WikilinkEmbed",
  "Comment",
  "CommentBlock",
]);

/** True when `pos` already sits inside a node the real parser/other inline
 *  features own — the guard that stops `cjkEmphasis` from double-applying or
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

const RESCUE_CLASS: Record<DelimiterKind, string> = { em: "cm-em", strong: "cm-strong" };

export const cjkEmphasis: InlineFeature = {
  nodes: CLAIMED_NODES,
  enter(node, ctx) {
    const text = ctx.state.sliceDoc(node.from, node.to);
    if (!hasEmphasisMarker(text)) return; // early-out: no `*` at all → zero cost
    const tree = syntaxTree(ctx.state);
    const isClaimedByOther = (start: number) => alreadyStyled(tree, node.from + start);
    for (const run of findCjkEmphasisRuns(text, isClaimedByOther)) {
      const openStart = node.from + run.openStart;
      const openEnd = node.from + run.openEnd;
      const closeStart = node.from + run.closeStart;
      const closeEnd = node.from + run.closeEnd;
      // Defense in depth, not the primary guard anymore: findCjkEmphasisRuns
      // already dropped any run where isClaimedByOther(run.start) was true
      // *before* pairing (see its doc comment), so neither openStart nor
      // closeStart should ever trip this for a run it returns. Kept in case
      // a future caller builds a CjkEmphasisRun some other way without
      // threading the predicate through.
      if (alreadyStyled(tree, openStart) || alreadyStyled(tree, closeStart)) continue;
      ctx.push({
        from: openEnd,
        to: closeStart,
        deco: Decoration.mark({ class: RESCUE_CLASS[run.kind] }),
        conceal: false,
      });
      ctx.push({ from: openStart, to: openEnd, deco: hide, conceal: true });
      ctx.push({ from: closeStart, to: closeEnd, deco: hide, conceal: true });
    }
    return; // descend — other inline features still process the same node
  },
};
