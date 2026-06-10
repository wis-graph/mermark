import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const STYLE: Record<string, string> = {
  StrongEmphasis: "cm-strong",
  Emphasis: "cm-em",
  InlineCode: "cm-inline-code",
  Strikethrough: "cm-strike",
};
// Marker node names produced by lang-markdown / GFM.
const MARKERS = new Set([
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "HeaderMark",
  "QuoteMark",
  "LinkMark",
]);

const hide = Decoration.replace({});

// RangeSetBuilder requires ranges in ascending `from` order, so collect → sort → build.
function build(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const cls = STYLE[node.name];
        if (cls) ranges.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: cls }) });
        if (MARKERS.has(node.name) && node.to > node.from)
          ranges.push({ from: node.from, to: node.to, deco: hide });
      },
    });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

export const inlineDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
