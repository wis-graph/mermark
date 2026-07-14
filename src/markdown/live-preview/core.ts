import { foldedRanges, syntaxTree } from "@codemirror/language";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  keymap,
} from "@codemirror/view";
import { EditorSelection, Facet, Prec, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Transaction, Range } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

// ---------------------------------------------------------------------------
// Live-preview core. Features (markdown/live-preview/features/*) register what
// syntax nodes they handle; this module walks the tree and dispatches to them,
// applies the Obsidian-style reveal rule, and wires the two CM pipelines:
// inline decorations (ViewPlugin) and block widgets (StateField).
//
// The mental model: the document is always raw markdown. Decorations only
// *render* it; concealing decorations are dropped for any line the selection
// touches, so the cursor edits the real source in place.
// ---------------------------------------------------------------------------

export type PreviewMode = "edit" | "read";

/** "edit" = live preview (cursor reveals source); "read" = render is fixed. */
export const modeFacet = Facet.define<PreviewMode, PreviewMode>({
  combine: (values) => values[0] ?? "read",
});

/** A concealing or styling decoration over [from,to]. `conceal` ones are
 *  dropped while the selection touches their line (edit mode). */
export interface Spec {
  from: number;
  to: number;
  deco: Decoration;
  conceal: boolean;
}

/** Replace decoration that hides source text outright. */
export const hide = Decoration.replace({});

/** True when any selection range touches [from,to] expanded to whole lines. */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  const lineFrom = state.doc.lineAt(from).from;
  const lineTo = state.doc.lineAt(Math.min(to, state.doc.length)).to;
  return state.selection.ranges.some((r) => r.from <= lineTo && r.to >= lineFrom);
}

/** Reveal only happens in edit mode; reader mode never un-conceals. */
export function revealed(state: EditorState, from: number, to: number): boolean {
  return state.facet(modeFacet) === "edit" && selectionTouches(state, from, to);
}

/** True when a click target lands on a rendered external link (marked by
 *  `data-href` — the shared contract from markdown/open-external.ts),
 *  including one drawn inside a block widget's DOM (a table cell). Domain
 *  rule this names: "activating a link is not entering a block", so
 *  `clickEntry` must yield to the link's own listener instead of claiming the
 *  event for block-entry. Pure query. */
export function clickLandsOnLink(target: EventTarget | null): boolean {
  return (target as HTMLElement)?.closest?.("[data-href]") != null;
}

function treeChanged(a: EditorState, b: EditorState): boolean {
  return syntaxTree(a) !== syntaxTree(b);
}

/** Lowercased info string of a fenced code block (the `ts` in ```ts), or "". */
export function fencedInfo(state: EditorState, node: SyntaxNode): string {
  const info = node.getChild("CodeInfo");
  return info ? state.sliceDoc(info.from, info.to).trim().toLowerCase() : "";
}

/** Run `fn` once per line a node spans (line-start offsets, deduped by caller). */
export function eachLine(
  state: EditorState,
  from: number,
  to: number,
  fn: (lineFrom: number) => void,
) {
  let pos = from;
  const end = Math.min(to, state.doc.length);
  for (;;) {
    const line = state.doc.lineAt(pos);
    fn(line.from);
    if (line.to >= end) break;
    pos = line.to + 1;
  }
}

function stripQuote(text: string, depth: number): string {
  let t = text;
  for (let i = 0; i < depth; i++) t = t.replace(/^\s*>\s?/, "");
  return t;
}

/** Lines of [from,to], each stripped of `depth` leading blockquote markers. */
export function strippedLines(
  state: EditorState,
  from: number,
  to: number,
  depth: number,
): string[] {
  const out: string[] = [];
  eachLine(state, from, to, (lf) => out.push(stripQuote(state.doc.lineAt(lf).text, depth)));
  return out;
}

/** Body lines of a fenced block: drop the opening ```lang line (always) and the
 *  closing ``` line (only if present — an unclosed fence has none). The single
 *  definition of "a fence body", shared by the code-block and mermaid features. */
export function dropFences(lines: string[]): string[] {
  return lines.slice(1, lines[lines.length - 1]?.trim().startsWith("```") ? -1 : undefined);
}

// --- Inline features -------------------------------------------------------

/** Handed to an inline feature so it can emit decorations without knowing how
 *  they are collected, deduped or revealed. */
export interface InlineCtx {
  state: EditorState;
  baseDir: string;
  currentFile: string;
  /** Emit an inline conceal/style decoration. */
  push(spec: Spec): void;
  /** Add a CSS class to a whole line (deduped). */
  line(lineFrom: number, cls: string): void;
  /** Visit each line a range spans. */
  eachLine(from: number, to: number, fn: (lineFrom: number) => void): void;
}

export interface InlineFeature {
  /** Syntax node names this feature claims. */
  nodes: string[];
  /** Emit decorations for a claimed node. Return `false` to skip its children
   *  (matches `tree.iterate`'s enter contract). */
  enter(node: SyntaxNode, ctx: InlineCtx): boolean | void;
  /** Optional view-level extension (e.g. a click handler). */
  view?: Extension;
}

export function inlinePreview(
  features: InlineFeature[],
  baseDir: string,
  currentFile: string,
): Extension {
  const byNode = new Map<string, InlineFeature[]>();
  for (const f of features) {
    for (const n of f.nodes) {
      const list = byNode.get(n) ?? [];
      list.push(f);
      byNode.set(n, list);
    }
  }

  function build(view: EditorView): DecorationSet {
    const state = view.state;
    const specs: Spec[] = [];
    const lineClasses = new Map<number, Set<string>>();
    const ctx: InlineCtx = {
      state,
      baseDir,
      currentFile,
      push: (s) => specs.push(s),
      line: (lf, cls) => {
        let set = lineClasses.get(lf);
        if (!set) lineClasses.set(lf, (set = new Set()));
        set.add(cls);
      },
      eachLine: (f, t, fn) => eachLine(state, f, t, fn),
    };
    const tree = syntaxTree(state);
    for (const { from, to } of view.visibleRanges) {
      tree.iterate({
        from,
        to,
        enter(node) {
          const fs = byNode.get(node.name);
          if (!fs) return;
          let descend: boolean | undefined = undefined;
          for (const f of fs) if (f.enter(node.node, ctx) === false) descend = false;
          return descend;
        },
      });
    }
    const ranges: Range<Decoration>[] = [];
    for (const s of specs) {
      if (s.conceal && revealed(state, s.from, s.to)) continue;
      ranges.push(s.deco.range(s.from, s.to));
    }
    for (const [lineFrom, classes] of lineClasses) {
      ranges.push(Decoration.line({ class: [...classes].join(" ") }).range(lineFrom));
    }
    return Decoration.set(ranges, true);
  }

  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view);
        }
        update(u: ViewUpdate) {
          if (
            u.docChanged ||
            u.viewportChanged ||
            u.selectionSet ||
            treeChanged(u.startState, u.state) ||
            u.startState.facet(modeFacet) !== u.state.facet(modeFacet) ||
            // fold state changed → list bullets re-render to add/remove their halo
            foldedRanges(u.startState) !== foldedRanges(u.state)
          )
            this.decorations = build(u.view);
        }
      },
      { decorations: (v) => v.decorations },
    ),
    ...features.flatMap((f) => (f.view ? [f.view] : [])),
  ];
}

// --- Block features --------------------------------------------------------

/** A block-level render (mermaid / table / display math). `widget()` builds a
 *  fresh widget; it may be called again when only the selection changed. */
export interface BlockSpec {
  kind: string;
  from: number;
  to: number;
  src: string;
  widget(): WidgetType;
}

export interface BlockCtx {
  state: EditorState;
  /** Lines of the block, stripped of any enclosing blockquote markers. */
  strippedLines(from: number, to: number): string[];
  /** Body lines of a fenced block (opening ```lang and closing ``` removed). */
  fencedBody(node: SyntaxNode): string[];
}

export interface BlockFeature {
  /** Syntax node names that may be this block. */
  nodes: string[];
  /** Claim a node as a block, or return null if it isn't one. */
  match(node: SyntaxNode, ctx: BlockCtx): BlockSpec | null;
}

// Don't descend into nodes that can't contain block widgets — avoids walking
// every inline node of large documents on each edit.
const NO_BLOCKS_INSIDE = new Set([
  "Paragraph",
  "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6",
  "SetextHeading1", "SetextHeading2",
  "HTMLBlock", "CommentBlock", "LinkReference", "HorizontalRule",
]);

interface BlockValue {
  specs: BlockSpec[];
  deco: DecorationSet;
}

/** The domain rule that makes a runtime-registered block feature list safe: a
 *  single syntax node may become at most ONE block widget. Named because it
 *  used to be an unstated invariant enforced only by mermaid/codeBlock's own
 *  mutual exclusion (mermaid returns null for non-"mermaid" fences, codeBlock
 *  claims everything else) — that hand-rolled exclusivity breaks the instant a
 *  third feature claims FencedCode. The first feature (in registry order) to
 *  return a non-null BlockSpec for `node` wins; later candidates are not even
 *  tried. For the shipped 5 features this is behavior-neutral: the only two
 *  that share a claimable node (mermaid, codeBlock, both on FencedCode) are
 *  already mutually exclusive, so "first wins" and "collect all" produce
 *  identical output. `emit` receives the winning spec (if any); pure w.r.t.
 *  its inputs except for the single `emit` side effect the caller controls. */
export function firstClaimWins(
  features: BlockFeature[],
  node: SyntaxNode,
  ctx: BlockCtx,
  emit: (spec: BlockSpec) => void,
): void {
  for (const f of features) {
    const s = f.match(node, ctx);
    if (s) {
      emit(s);
      return;
    }
  }
}

/** Decide where a vertical caret move should land so it *reveals* a block
 *  instead of leaping over it.
 *
 *  Block widgets are atomic, so CM's geometric vertical motion (moveVertically)
 *  skips across them and lands the caret on text past the block — the cause of
 *  the multi-line "leaps". Given the caret's current head and that geometric
 *  target head, this finds the first un-revealed block the move *crossed* (its
 *  half-open `[from,to)` overlaps the travelled span) and returns the offset to
 *  snap to: the block's first line going down, its last source line going up.
 *  Returns null when no block was crossed (→ let default motion run, preserving
 *  wrapped-line visual-row navigation) or when the caret is already on that edge
 *  (→ let default motion walk out, so single-line blocks don't ping-pong).
 *
 *  Pure (no layout): unit-testable by feeding pre-computed heads + specs. */
export function pickBlockLanding(
  state: EditorState,
  oldHead: number,
  targetHead: number,
  dir: 1 | -1,
  specs: BlockSpec[],
): number | null {
  if (oldHead === targetHead) return null;
  const lo = Math.min(oldHead, targetHead);
  const hi = Math.max(oldHead, targetHead);
  const crossed = specs
    .filter((s) => s.from < hi && s.to > lo && !revealed(state, s.from, s.to))
    .sort((a, b) => a.from - b.from);
  if (!crossed.length) return null;
  // down → nearest block below (smallest from); up → nearest above (largest from)
  const block = dir === 1 ? crossed[0] : crossed[crossed.length - 1];
  const anchor =
    dir === 1 ? block.from : state.doc.lineAt(Math.max(block.from, block.to - 1)).from;
  return anchor === oldHead ? null : anchor;
}

/** Dispatch this to force block widgets to rebuild (e.g. mermaid re-render on a
 *  live theme change), even though the document hasn't changed. */
export const refreshBlocks = StateEffect.define<null>();

export function blockPreview(features: BlockFeature[]): Extension {
  const byNode = new Map<string, BlockFeature[]>();
  for (const f of features) {
    for (const n of f.nodes) {
      const list = byNode.get(n) ?? [];
      list.push(f);
      byNode.set(n, list);
    }
  }

  function computeSpecs(state: EditorState): BlockSpec[] {
    const specs: BlockSpec[] = [];
    let quoteDepth = 0;
    const ctx: BlockCtx = {
      state,
      strippedLines: (from, to) => strippedLines(state, from, to, quoteDepth),
      fencedBody: (node) => dropFences(strippedLines(state, node.from, node.to, quoteDepth)),
    };
    syntaxTree(state).iterate({
      enter(node) {
        if (node.name === "Blockquote") {
          quoteDepth++;
          return;
        }
        if (NO_BLOCKS_INSIDE.has(node.name)) return false;
        const fs = byNode.get(node.name);
        if (!fs) return;
        firstClaimWins(fs, node.node, ctx, (s) => specs.push(s));
        return false; // claimed block nodes never nest a block widget
      },
      leave(node) {
        if (node.name === "Blockquote") quoteDepth--;
      },
    });
    return specs;
  }

  function buildDeco(state: EditorState, specs: BlockSpec[]): DecorationSet {
    const ranges: Range<Decoration>[] = [];
    for (const s of specs) {
      if (revealed(state, s.from, s.to)) continue; // cursor inside → raw source
      ranges.push(Decoration.replace({ widget: s.widget(), block: true }).range(s.from, s.to));
    }
    return Decoration.set(ranges, true);
  }

  const field = StateField.define<BlockValue>({
    create(state) {
      const specs = computeSpecs(state);
      return { specs, deco: buildDeco(state, specs) };
    },
    update(value, tr: Transaction) {
      if (tr.docChanged || treeChanged(tr.startState, tr.state)) {
        const specs = computeSpecs(tr.state);
        return { specs, deco: buildDeco(tr.state, specs) };
      }
      if (
        tr.selection ||
        tr.startState.facet(modeFacet) !== tr.state.facet(modeFacet) ||
        tr.effects.some((e) => e.is(refreshBlocks))
      )
        return { specs: value.specs, deco: buildDeco(tr.state, value.specs) };
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  // Vertical entry. An atomic block widget can't be reached by the arrow keys —
  // CM's geometric motion *skips across* it (the multi-line leaps) — so the
  // reveal never fires. We delegate to the SAME geometric motion CM would use
  // (moveVertically, so wrapped-line visual-row navigation is unchanged), then
  // if that move crossed a rendered block, snap the caret onto the block's near
  // edge to reveal it. Falls through (returns false) for pure-text moves and at
  // the document edge, so default motion handles those.
  function moveOrEnter(view: EditorView, dir: 1 | -1): boolean {
    const state = view.state;
    if (state.facet(modeFacet) !== "edit") return false;
    const main = state.selection.main;
    if (!main.empty || state.selection.ranges.length > 1) return false; // selections / multi-cursor → default
    const value = state.field(field, false);
    if (!value?.specs.length) return false;
    const target = view.moveVertically(main, dir === 1); // CM's own geometric target
    if (target.head === main.head) return false; // doc edge → default
    const anchor = pickBlockLanding(state, main.head, target.head, dir, value.specs);
    if (anchor === null) return false; // no block crossed → default (R2 wrap motion)
    view.dispatch({
      // carry the goal column so leaving the block on the next press keeps the
      // caret's horizontal position instead of resetting to column 0. Use the
      // target's goalColumn (moveVertically recomputes it from the pre-entry
      // caret x): main.goalColumn is undefined after a horizontal move/click.
      selection: EditorSelection.cursor(anchor, dir === 1 ? -1 : 1, undefined, target.goalColumn ?? main.goalColumn),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  }

  const entryKeymap = Prec.high(
    keymap.of([
      { key: "ArrowDown", run: (v) => moveOrEnter(v, 1) },
      { key: "ArrowUp", run: (v) => moveOrEnter(v, -1) },
    ]),
  );

  // Click entry: in edit mode a click on a rendered block places the caret
  // inside it (revealing the source). A capture-phase listener on the editor
  // root runs before CM's default caret placement; we stop the event so it
  // doesn't fight our caret. Mermaid is intentionally EXCLUDED — a click there
  // pans/zooms the diagram instead (enter it with the arrow keys to edit).
  const BLOCK_SEL = ".cm-table, .cm-math-block, .cm-frontmatter";
  const clickEntry = ViewPlugin.fromClass(
    class {
      readonly onDown: (e: MouseEvent) => void;
      constructor(readonly view: EditorView) {
        this.onDown = (e) => {
          // Activating a rendered link is a different gesture from entering a
          // block to edit its source — even when the link sits inside a
          // block widget's DOM (a table cell). This must be checked before
          // any block-entry logic below claims the event, in both edit AND
          // read mode (G8: external links open in read mode too), so the
          // anchor's own click-to-open listener (inline-render.ts /
          // WikilinkWidget) gets to run undisturbed.
          if (clickLandsOnLink(e.target)) return;
          if (view.state.facet(modeFacet) !== "edit") return;
          const host = (e.target as HTMLElement).closest?.(BLOCK_SEL) as HTMLElement | null;
          if (!host) return;
          e.preventDefault();
          e.stopPropagation();
          view.dispatch({ selection: { anchor: view.posAtDOM(host) } });
        };
        view.dom.addEventListener("mousedown", this.onDown, true);
      }
      destroy() {
        this.view.dom.removeEventListener("mousedown", this.onDown, true);
      }
    },
  );

  return [field, entryKeymap, clickEntry];
}
