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

/** One markdown-block instance's reveal range plus its candidate fence
 *  lines — the unit computeCandidates walks the tree for. */
interface BlockCandidate {
  from: number;
  to: number;
  lines: FenceLine[];
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
      const lines = concealableFenceLines(state, node.node, spec.fenceNode);
      if (lines.length) out.push({ from: node.from, to: node.to, lines });
    },
  });
  return out;
}

/** Reveal is BLOCK-level (design §4.2): if the caret touches any line of the
 *  block, both fence lines reappear together — not per-fence-line, or a
 *  hidden fence line would have no way for the caret to ever reach it. */
function buildDeco(state: EditorState, candidates: BlockCandidate[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const block of candidates) {
    if (revealed(state, block.from, block.to)) continue;
    for (const l of block.lines) ranges.push(Decoration.replace({ block: true }).range(l.from, l.to));
  }
  return Decoration.set(ranges, true);
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
