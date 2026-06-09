import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";

/** Split a GFM table row into trimmed cells (strip leading/trailing pipes). */
function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Map an alignment spec cell (`:---`, `---:`, `:--:`, `---`) to a CSS text-align. */
function alignOf(spec: string): string | null {
  const s = spec.trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    const lines = this.source.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) {
      wrap.textContent = this.source;
      return wrap;
    }

    const table = document.createElement("table");
    table.className = "cm-table";

    const headerCells = splitRow(lines[0]);
    const aligns = splitRow(lines[1]).map(alignOf);

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    headerCells.forEach((cell, i) => {
      const th = document.createElement("th");
      th.textContent = cell;
      const a = aligns[i];
      if (a) th.style.textAlign = a;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (let r = 2; r < lines.length; r++) {
      const cells = splitRow(lines[r]);
      const tr = document.createElement("tr");
      cells.forEach((cell, i) => {
        const td = document.createElement("td");
        td.textContent = cell;
        const a = aligns[i];
        if (a) td.style.textAlign = a;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

// Block decorations (block:true) MUST come from a StateField, not a ViewPlugin —
// CM6 throws "Block decorations may not be specified via plugins" otherwise.
function build(state: EditorState): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const source = state.doc.sliceString(node.from, node.to);
      b.add(node.from, node.to, Decoration.replace({ widget: new TableWidget(source), block: true }));
    },
  });
  return b.finish();
}

export const tables = StateField.define<DecorationSet>({
  create(state) {
    return build(state);
  },
  update(deco, tr) {
    return tr.docChanged ? build(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
