import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

class SupWidget extends WidgetType {
  constructor(readonly label: string) { super(); }
  eq(o: SupWidget) { return o.label === this.label; }
  toDOM() {
    const s = document.createElement("sup");
    s.className = "cm-footnote-ref";
    s.textContent = this.label;
    return s;
  }
}

const DEF = /^\[\^([^\]]+)\]:\s/;
const REF = /\[\^([^\]]+)\]/g;

function build(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  const doc = view.state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (DEF.test(line.text)) {
      ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: "cm-footnote-def" }) });
      continue; // don't turn the def's own [^id] into a sup
    }
    let m: RegExpExecArray | null;
    REF.lastIndex = 0;
    while ((m = REF.exec(line.text))) {
      const from = line.from + m.index;
      ranges.push({ from, to: from + m[0].length, deco: Decoration.replace({ widget: new SupWidget(m[1]) }) });
    }
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder<Decoration>();
  for (const r of ranges) b.add(r.from, r.to, r.deco);
  return b.finish();
}

export const footnotes = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = build(v); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
  },
  { decorations: (v) => v.decorations },
);
