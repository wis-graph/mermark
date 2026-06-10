import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-task-checkbox";
    input.disabled = true;
    input.checked = this.checked;
    return input;
  }
  ignoreEvent() {
    return true;
  }
}

// Matches a task-list marker at line start: list bullet/number + `[ ]` / `[x]`.
const TASK = /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/;

function build(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  const doc = view.state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const m = TASK.exec(line.text);
    if (!m) continue;
    const from = line.from + m[1].length; // start of `[`
    const to = from + 3; // `[x]` / `[ ]` is exactly 3 chars
    ranges.push({ from, to, deco: Decoration.replace({ widget: new CheckboxWidget(/[xX]/.test(m[2])) }) });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder<Decoration>();
  for (const r of ranges) b.add(r.from, r.to, r.deco);
  return b.finish();
}

export const checkboxes = ViewPlugin.fromClass(
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
