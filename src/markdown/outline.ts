import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

// ---------------------------------------------------------------------------
// Pure heading extraction for the outline (table of contents). Reads only the
// parse tree + doc — no decorations, no view, no side effects (CQS: query).
//
// This is deliberately separate from features/heading.ts: that file maps a
// heading NODE NAME to a CSS class (a render concern); the outline needs the
// integer LEVEL and a mark-stripped DISPLAY STRING (a navigation concern). Two
// concerns, two modules — heading.ts stays untouched.
// ---------------------------------------------------------------------------

/** Heading node name → its integer level. The outline needs a number (for
 *  indent depth); features/heading.ts only needs a class, so it can't supply
 *  this. ATX1..6 + Setext1/2 are the only headings the parser emits. */
const LEVEL: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

export interface Heading {
  /** 1..6 — the heading depth, used for the outline indent. */
  level: number;
  /** Display text with markdown markers stripped (`**B**` → `B`, links → text). */
  text: string;
  /** Offset of the heading line's start — the jumpTo target (single landing). */
  pos: number;
}

/** Placeholder shown when a heading has no visible text (e.g. a bare `#`). A
 *  blank outline row would be unclickable-looking; this keeps every heading
 *  navigable. */
const EMPTY_HEADING = "(제목 없음)";

/** Node names whose entire span is a marker to drop from the display text. These
 *  are the syntactic scaffolding (`*`, `` ` ``, `#`, `==`, `[[`, `]]`) that the
 *  live preview also conceals — stripping them here gives the outline the same
 *  "rendered" text the reader sees, computed straight from the tree. */
const MARK_NODE = /Mark$/;

/** Structural child nodes that carry non-display content: a link's URL and a
 *  wikilink's raw target (when an alias is present, the alias is what shows).
 *  Dropped wholesale so `[txt](url)` → `txt` and `[[note|Alias]]` → `Alias`. */
function isHiddenStructural(node: SyntaxNode): boolean {
  if (node.name === "URL") return true;
  // A wikilink target is hidden only when an alias sibling supplies the display
  // text; a bare `[[target]]` shows the target itself.
  if (node.name === "WikilinkTarget") {
    return node.parent?.getChild("WikilinkAlias") != null;
  }
  return false;
}

/** Collect [from,to) ranges within a heading whose text must NOT appear in the
 *  display string: every `*Mark` node plus hidden structural nodes (URL, aliased
 *  wikilink target). Tree-based, so fenced/escaped content is handled for free.
 *  Pure. */
function hiddenRanges(node: SyntaxNode): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  node.cursor().iterate((n) => {
    if (n.node === node) return; // skip the heading node itself
    if (MARK_NODE.test(n.name) || isHiddenStructural(n.node)) {
      if (n.to > n.from) ranges.push([n.from, n.to]);
      return false; // its children are inside the marker — don't double-visit
    }
  });
  return ranges;
}

/** The heading's content span, with the leading `#{1,6}` + space and any
 *  trailing closing `#`s excluded. ATX HeaderMark nodes already bound these, but
 *  reading the doc slice between them keeps this independent of how many
 *  HeaderMarks the parser emits (ATX has 1 or 2; Setext has its own marker on
 *  the line below, which sits outside the content). */
function contentSpan(state: EditorState, node: SyntaxNode): [number, number] {
  const firstLine = state.doc.lineAt(node.from);
  // ATX HeaderMarks live ON the first line: the opening `#`s, and (optionally) a
  // trailing closer. A Setext HeaderMark is the `===`/`---` underline on the
  // line BELOW, so it starts past the first line's end — that's how we tell them
  // apart and avoid mistaking the underline for an opening marker.
  const atxMarks = node
    .getChildren("HeaderMark")
    .filter((m) => m.from <= firstLine.to);
  if (atxMarks.length > 0) {
    const from = atxMarks[0].to;
    const to = atxMarks.length > 1 ? atxMarks[atxMarks.length - 1].from : node.to;
    return [from, to];
  }
  // Setext: the heading text is the first line; the underline sits below it.
  return [node.from, firstLine.to];
}

/**
 * The rendered display text of one heading: the content span minus the hidden
 * marker/structural ranges, stitched and whitespace-normalized. Empty result →
 * the placeholder. This is the "what the heading is called" domain rule in one
 * named place (not an inline regex chain at the call site). Pure.
 */
export function headingDisplayText(state: EditorState, node: SyntaxNode): string {
  const [from, to] = contentSpan(state, node);
  const hidden = hiddenRanges(node)
    .filter(([f]) => f >= from && f < to)
    .sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = from;
  for (const [hf, ht] of hidden) {
    if (hf > cursor) out += state.sliceDoc(cursor, hf);
    cursor = Math.max(cursor, ht);
  }
  if (cursor < to) out += state.sliceDoc(cursor, to);
  const normalized = out.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : EMPTY_HEADING;
}

/**
 * Every heading in the document, in document order, as {level, text, pos}.
 * Reads the parse tree (so headings inside code fences / not real headings are
 * never nodes → never collected) and the doc text. Pure query: no side effects.
 */
export function collectHeadings(state: EditorState): Heading[] {
  const headings: Heading[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      const level = LEVEL[node.name];
      if (level === undefined) return;
      headings.push({
        level,
        text: headingDisplayText(state, node.node),
        pos: state.doc.lineAt(node.from).from,
      });
    },
  });
  return headings;
}

/** Normalize heading text for anchor matching: collapse internal whitespace,
 *  trim, and lowercase (Obsidian-style case-insensitive heading anchors).
 *  Applied to BOTH sides of the comparison in findHeadingByText so a heading's
 *  displayText and a `[[#anchor]]` target match through the SAME rule instead
 *  of two ad hoc normalizations drifting apart. Internal — not part of the
 *  outline's public surface. Pure. */
function normalizeHeadingText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The line-start position (the same landing collectHeadings/jumpTo use) of the
 * first heading in document order whose display text matches `text` once both
 * sides are normalized (whitespace collapsed + trim + case-insensitive), or
 * null when no heading matches. Built on collectHeadings, so it inherits the
 * tree-based guarantee that a `# fake` heading inside a fenced code block is
 * never a candidate. Pure query.
 */
export function findHeadingByText(state: EditorState, text: string): number | null {
  const target = normalizeHeadingText(text);
  const match = collectHeadings(state).find((h) => normalizeHeadingText(h.text) === target);
  return match ? match.pos : null;
}
