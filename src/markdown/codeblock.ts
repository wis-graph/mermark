import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const blockLine = Decoration.line({ class: "cm-code-block" });

function infoString(view: EditorView, fenceFrom: number): string {
  const line = view.state.doc.lineAt(fenceFrom);
  return line.text.replace(/^\s*`{3,}\s*/, "").trim().toLowerCase();
}

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "FencedCode") return;
        const lang = infoString(view, node.from);
        if (lang === "mermaid" || lang === "math") return; // handled by widgets
        let pos = node.from;
        while (pos <= node.to) {
          const line = view.state.doc.lineAt(pos);
          b.add(line.from, line.from, blockLine);
          if (line.to >= node.to) break;
          pos = line.to + 1;
        }
      },
    });
  }
  return b.finish();
}

export const codeBlocks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) {
      this.decorations = build(v);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
