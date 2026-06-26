import { WidgetType } from "@codemirror/view";
import { renderInlineMarkdown } from "./inline-render";

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

export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    // Click→source is handled centrally in live-preview/core (clickEntry, a
    // capture-phase listener, edit-mode only). Read mode is preview — a click
    // does nothing, so no per-widget handler here.
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
      th.appendChild(renderInlineMarkdown(cell));
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
        td.appendChild(renderInlineMarkdown(cell));
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
