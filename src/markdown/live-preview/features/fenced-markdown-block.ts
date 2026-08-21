import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import type { Extension, Range, Transaction } from "@codemirror/state";
import { StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { modeFacet, revealed, treeChanged, type InlineFeature } from "../core";
import { markdownBlockFences, type MarkdownBlockFenceSpec } from "../../fence-types";

// ---------------------------------------------------------------------------
// Generic renderer for every `kind: "markdown-block"` fence-types.ts entry
// (currently just ```highlight — design `_workspace/01_architect_design.md`
// §4). Table-driven, not "highlight" hardcoded: a second markdown-block entry
// needs a fence-types.ts row only, no new feature file.
//
// Unlike a widget block (mermaid/table/math), the body is NOT replaced — it
// stays real markdown text so it edits in place (design §2). Rendering is two
// independent pieces:
//   1. an InlineFeature line class on every body+fence line (always visible,
//      like list-line's depth class — not conceal-gated)
//   2. a `view` StateField that hides the two fence LINES themselves with a
//      widget-less `Decoration.replace({block:true})`. Hiding a full line is a
//      block decoration, which — same render-smoke invariant as block widgets
//      — a ViewPlugin cannot emit; only a StateField can.
// ---------------------------------------------------------------------------

/** node name → its fence-types.ts spec, built once at module load. No
 *  defensive `s.node && s.lineClass` filter needed — `markdownBlockFences()`
 *  is already typed `readonly MarkdownBlockFenceSpec[]`, so every element
 *  HAS `node`/`fenceNode`/`lineClass` (fence-types.ts's discriminated union
 *  makes a half-populated row a compile error, not a silent no-op). */
const SPEC_BY_NODE: ReadonlyMap<string, MarkdownBlockFenceSpec> = new Map(
  markdownBlockFences().map((s) => [s.node, s]),
);

/** Line class on every source line of a markdown-block fence (body AND both
 *  fence lines — CSS distinguishes them further if needed). Always visible,
 *  regardless of reveal state — same contract as list-line's depth class.
 *  Descends (no `return false`) so the body's inline markdown — `**bold**`,
 *  `==mark==`, links, wikilinks — renders normally as ordinary Paragraph
 *  children (design §4.1-1). */
export const fencedMarkdownBlockLines: InlineFeature = {
  nodes: [...SPEC_BY_NODE.keys()],
  enter(node, ctx) {
    const spec = SPEC_BY_NODE.get(node.name);
    if (!spec) return;
    ctx.eachLine(node.from, node.to, (lf) => ctx.line(lf, spec.lineClass));
  },
  view: fenceConcealField(),
};

interface FenceLine {
  from: number;
  to: number;
}

/** The fence-line ranges of ONE block that are candidates for hiding — pure
 *  structural query, no reveal/selection knowledge. Named because it encodes
 *  one deliberate domain rule (design §4.2): a block with ZERO body lines
 *  (`` ```highlight\n``` `` or an opener at EOF with nothing after) returns an
 *  EMPTY array — hiding both fences of an empty block would erase every line
 *  a cursor could land on to reveal it again, a permanent-edit-lock trap. An
 *  unclosed block only ever offers its opening fence (there is no closer). */
export function concealableFenceLines(
  state: EditorState,
  blockNode: SyntaxNode,
  fenceNode: string,
): FenceLine[] {
  const fences = blockNode.getChildren(fenceNode);
  if (fences.length === 0) return [];
  const open = fences[0];
  const close = fences.length > 1 ? fences[1] : null;
  const openLine = state.doc.lineAt(open.from);
  const bodyFrom = openLine.to + 1;
  const bodyTo = close ? state.doc.lineAt(close.from).from - 1 : blockNode.to;
  if (bodyFrom > bodyTo) return []; // no body line between the fences
  const lines: FenceLine[] = [lineRange(state, open.from)];
  if (close) lines.push(lineRange(state, close.from));
  return lines;
}

function lineRange(state: EditorState, pos: number): FenceLine {
  const line = state.doc.lineAt(pos);
  return { from: line.from, to: line.to };
}

/** One markdown-block instance's reveal range, its fence-line positions (open
 *  always present, close only when the block is actually closed), which of
 *  those fence lines are candidates for HIDING, and its OWN `lineClass` (from
 *  fence-types.ts, same string `fencedMarkdownBlockLines` above already
 *  stamps on every body/fence line) — so the corner-class decorations below
 *  are derived per-block instead of a single hardcoded pair (audit
 *  `_workspace/04_audit_report.md` 🟡#1: this module's own doc comment
 *  promises "a second markdown-block entry needs a fence-types.ts row only,
 *  no new feature file" — a literal `cm-highlight-block-first/-last` would
 *  have broken that promise the instant a second entry arrived). `open`/
 *  `close` are tracked separately from `concealLines` so a 0-body-line block
 *  (concealLines empty by design — see concealableFenceLines) still carries
 *  enough structure for visibleBlockEdges to give it corner classes on its
 *  (always-visible) fence lines, instead of dropping out of candidacy
 *  entirely. Not exported — no consumer outside this module (the render-smoke
 *  tests assert DOM/classList, not this type). */
interface BlockCandidate {
  from: number;
  to: number;
  open: FenceLine;
  close: FenceLine | null;
  concealLines: FenceLine[];
  lineClass: string;
}

/** Every markdown-block instance in the document, purely structural (no
 *  reveal/selection knowledge) — the half of the StateField recomputed only
 *  on docChanged/treeChanged, same split as core.ts's blockPreview field. */
function computeCandidates(state: EditorState): BlockCandidate[] {
  const out: BlockCandidate[] = [];
  if (SPEC_BY_NODE.size === 0) return out;
  syntaxTree(state).iterate({
    enter(node) {
      const spec = SPEC_BY_NODE.get(node.name);
      if (!spec) return;
      const fences = node.node.getChildren(spec.fenceNode);
      if (fences.length === 0) return; // no fence node at all — nothing to render
      const open = lineRange(state, fences[0]!.from);
      const close = fences.length > 1 ? lineRange(state, fences[1]!.from) : null;
      const concealLines = concealableFenceLines(state, node.node, spec.fenceNode);
      out.push({ from: node.from, to: node.to, open, close, concealLines, lineClass: spec.lineClass });
    },
  });
  return out;
}

/** `${lineClass}-first`/`-last` Decoration.line, one per lineClass, built
 *  once and reused (mirrors the old HIGHLIGHT_BLOCK_FIRST/LAST module-level
 *  consts — a Decoration object is cheap to intern and CM6 diffs decoration
 *  IDENTITY, not just class string, so reusing the same object across
 *  rebuilds avoids pointless reconciliation). Keyed by lineClass so today's
 *  single ```highlight spec produces the exact byte-identical
 *  `cm-highlight-block-first`/`-last` classnames as before this refactor —
 *  this is a generalization, not a behavior change. Exported (a pure query,
 *  no state/tree dependency) so a test can lock the derivation directly for
 *  a SECOND lineClass without having to register a whole fake Lezer node in
 *  the parser just to exercise this line — same "export the pure query for a
 *  direct unit test" pattern as `concealableFenceLines` above. */
const CORNER_DECO_CACHE = new Map<string, { first: Decoration; last: Decoration }>();
export function cornerDecos(lineClass: string): { first: Decoration; last: Decoration } {
  let pair = CORNER_DECO_CACHE.get(lineClass);
  if (!pair) {
    pair = {
      first: Decoration.line({ class: `${lineClass}-first` }),
      last: Decoration.line({ class: `${lineClass}-last` }),
    };
    CORNER_DECO_CACHE.set(lineClass, pair);
  }
  return pair;
}

/** Reveal is BLOCK-level (design §4.2): if the caret touches any line of the
 *  block, both fence lines reappear together — not per-fence-line, or a
 *  hidden fence line would have no way for the caret to ever reach it. */
function buildDeco(state: EditorState, candidates: BlockCandidate[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const block of candidates) {
    if (revealed(state, block.from, block.to)) continue;
    for (const l of block.concealLines) ranges.push(Decoration.replace({ block: true }).range(l.from, l.to));
  }
  for (const block of candidates) {
    const edges = visibleBlockEdges(state, block);
    const { first, last } = cornerDecos(block.lineClass);
    ranges.push(first.range(edges.first));
    ranges.push(last.range(edges.last)); // same pos as `first` on a 1-body-line block — CM combines both line decos' classes
  }
  return Decoration.set(ranges, true);
}

/** "지금 이 블록의 가시적 첫/마지막 줄이 어디인가" (pure query, design §4.2) —
 *  the corner-class owner. Three regimes, matching which lines are actually IN
 *  the DOM right now:
 *  - resting with a body (fences concealed): first/last = the first/last BODY
 *    line (the fence lines themselves are `Decoration.replace({block:true})`d
 *    out of the DOM by the loop above, so a corner class on them would never
 *    paint).
 *  - revealed (fences visible), OR resting with NO body
 *    (`block.concealLines` empty — concealableFenceLines' edit-lock-trap
 *    guard leaves both fences permanently un-hidden for a 0-body-line block):
 *    first/last = the opening/closing FENCE line, since that's what's
 *    actually rendered. An unclosed block (no closing fence) falls back to
 *    the block's own last source line.
 *  Deliberately NOT plain CSS (`:not(.cm-highlight-block) + .cm-highlight-block`
 *  / `:has()`, see design's 기각 대안): CM6 only mounts the visible viewport,
 *  so a sibling-selector "first" would false-positive on whatever body line
 *  happens to be scrolled to the top. This query works in DOCUMENT
 *  coordinates, immune to viewport windowing. Not exported — module-private
 *  like `BlockCandidate` (see that type's doc comment). */
function visibleBlockEdges(state: EditorState, block: BlockCandidate): { first: number; last: number } {
  const fencesAlwaysVisible = revealed(state, block.from, block.to) || block.concealLines.length === 0;
  if (fencesAlwaysVisible) {
    const lastLine = block.close ? block.close.from : state.doc.lineAt(block.to).from;
    return { first: block.open.from, last: lastLine };
  }
  const bodyFromLine = state.doc.lineAt(block.open.to + 1).from;
  const bodyToLine = block.close ? state.doc.lineAt(block.close.from - 1).from : state.doc.lineAt(block.to).from;
  return { first: bodyFromLine, last: bodyToLine };
}

interface FenceConcealValue {
  candidates: BlockCandidate[];
  deco: DecorationSet;
}

/** The fence-conceal `view` extension slot (design §4.1-2). Hiding a whole
 *  fence LINE is a block decoration (`block: true`, no line-break survives
 *  it), and CM6 throws "Block decorations may not be specified via plugins"
 *  the instant a ViewPlugin emits one — the exact invariant
 *  `render-smoke.test.ts` guards for block widgets. So, like core.ts's
 *  `blockPreview`, this MUST be a StateField: candidates (which lines COULD
 *  hide) recompute only on docChanged/treeChanged; the decoration set (which
 *  ones actually DO, given reveal state) also rebuilds on selection/mode
 *  changes, since `revealed` reads both. */
function fenceConcealField(): Extension {
  const field = StateField.define<FenceConcealValue>({
    create(state) {
      const candidates = computeCandidates(state);
      return { candidates, deco: buildDeco(state, candidates) };
    },
    update(value, tr: Transaction) {
      if (tr.docChanged || treeChanged(tr.startState, tr.state)) {
        const candidates = computeCandidates(tr.state);
        return { candidates, deco: buildDeco(tr.state, candidates) };
      }
      if (tr.selection || tr.startState.facet(modeFacet) !== tr.state.facet(modeFacet)) {
        return { candidates: value.candidates, deco: buildDeco(tr.state, value.candidates) };
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
  return field;
}
