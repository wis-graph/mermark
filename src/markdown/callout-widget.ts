import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const HEAD = /^>\s*\[!(\w+)\]\s*(.*)$/;

function build(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  const doc = view.state.doc;
  let n = 1;
  while (n <= doc.lines) {
    const line = doc.line(n);
    const h = HEAD.exec(line.text);
    if (h) {
      const type = h[1].toLowerCase();
      ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: `cm-callout cm-callout-${type} cm-callout-head`, attributes: { "data-callout": type } }) });
      // following blockquote lines belong to the same callout
      let k = n + 1;
      while (k <= doc.lines && doc.line(k).text.startsWith(">")) {
        ranges.push({ from: doc.line(k).from, to: doc.line(k).from, deco: Decoration.line({ class: `cm-callout cm-callout-${type}` }) });
        k++;
      }
      n = k;
    } else {
      n++;
    }
  }
  ranges.sort((a, b) => a.from - b.from);
  const b = new RangeSetBuilder<Decoration>();
  for (const r of ranges) b.add(r.from, r.to, r.deco);
  return b.finish();
}

export const callouts = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = build(v); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
  },
  { decorations: (v) => v.decorations },
);
