import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { Facet, StateField } from "@codemirror/state";
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
            u.startState.facet(modeFacet) !== u.state.facet(modeFacet)
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
        for (const f of fs) {
          const s = f.match(node.node, ctx);
          if (s) specs.push(s);
        }
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

  return StateField.define<BlockValue>({
    create(state) {
      const specs = computeSpecs(state);
      return { specs, deco: buildDeco(state, specs) };
    },
    update(value, tr: Transaction) {
      if (tr.docChanged || treeChanged(tr.startState, tr.state)) {
        const specs = computeSpecs(tr.state);
        return { specs, deco: buildDeco(tr.state, specs) };
      }
      if (tr.selection || tr.startState.facet(modeFacet) !== tr.state.facet(modeFacet))
        return { specs: value.specs, deco: buildDeco(tr.state, value.specs) };
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
}
