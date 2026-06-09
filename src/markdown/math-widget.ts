import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import katex from "katex";

class KatexWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) { super(); }
  eq(o: KatexWidget) { return o.tex === this.tex && o.display === this.display; }
  toDOM() {
    const span = document.createElement(this.display ? "div" : "span");
    span.className = this.display ? "cm-math-block" : "cm-math-inline";
    try {
      katex.render(this.tex, span, { displayMode: this.display, throwOnError: false });
    } catch (e) {
      span.textContent = `$${this.tex}$`;
    }
    return span;
  }
  ignoreEvent() { return true; }
}

const BLOCK = /\$\$([\s\S]+?)\$\$/g;
const INLINE = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;

function build(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  const text = view.state.doc.toString();
  const codeSpans: [number, number][] = [];
  syntaxTree(view.state).iterate({
    enter: (node) => {
      if (node.name === "FencedCode" || node.name === "InlineCode") codeSpans.push([node.from, node.to]);
    },
  });
  const inCode = (pos: number) => codeSpans.some(([a, b]) => pos >= a && pos < b);
  let m: RegExpExecArray | null;
  BLOCK.lastIndex = 0;
  const blockSpans: [number, number][] = [];
  while ((m = BLOCK.exec(text))) {
    if (inCode(m.index)) continue;
    blockSpans.push([m.index, m.index + m[0].length]);
    ranges.push({ from: m.index, to: m.index + m[0].length, deco: Decoration.replace({ widget: new KatexWidget(m[1].trim(), true), block: true }) });
  }
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    const start = m.index;
    if (blockSpans.some(([a, b]) => start >= a && start < b)) continue; // inside a block-math span
    if (inCode(start)) continue; // inside a code block / inline code
    ranges.push({ from: start, to: start + m[0].length, deco: Decoration.replace({ widget: new KatexWidget(m[1].trim(), false) }) });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder<Decoration>();
  for (const r of ranges) b.add(r.from, r.to, r.deco);
  return b.finish();
}

export const mathBlocks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = build(v); }
    update(u: ViewUpdate) { if (u.docChanged) this.decorations = build(u.view); }
  },
  { decorations: (v) => v.decorations },
);
