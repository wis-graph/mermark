import { WidgetType } from "@codemirror/view";

export interface FrontmatterScalar {
  key: string;
  value: string;
}

/** A frontmatter fence line: `---` or `...` (opener/closer of the YAML block). */
function isFenceLine(line: string): boolean {
  const t = line.trim();
  return t === "---" || t === "...";
}

/**
 * Parse the scalar `key: value` lines of a frontmatter block. First-pass scope
 * (by design): only flat `key: value` scalars. Nested mappings, lists (`- x`),
 * and multiline scalars (`|`, `>`) are skipped — not rendered as rows. The
 * opening/closing `---` fences are dropped. Pure query (no side effects).
 */
export function parseFrontmatterScalars(src: string): FrontmatterScalar[] {
  const out: FrontmatterScalar[] = [];
  for (const raw of src.split("\n")) {
    if (isFenceLine(raw)) continue;
    const line = raw.trimEnd();
    if (line.trim() === "") continue;
    if (/^\s/.test(line)) continue; // indented → nested/continuation, skip
    if (/^\s*-\s/.test(line)) continue; // list item, skip
    const m = /^([^:\s][^:]*):(?:\s(.*)|)$/.exec(line);
    if (!m) continue; // not a flat scalar (e.g. `key:` with a block follows), skip
    out.push({ key: m[1].trim(), value: (m[2] ?? "").trim() });
  }
  return out;
}

/** Renders a document's top YAML frontmatter as an Obsidian-style key/value
 *  table. Source-only; the markdown pipeline drops it on caret entry (reveal),
 *  so editing happens on the raw YAML. XSS-safe: textContent only. */
export class FrontmatterWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: FrontmatterWidget) {
    return o.source === this.source;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-frontmatter";
    // Click→source is handled centrally in live-preview/core (clickEntry); no
    // per-widget handler.
    const table = document.createElement("table");
    table.className = "cm-frontmatter-table";
    const tbody = document.createElement("tbody");
    for (const { key, value } of parseFrontmatterScalars(this.source)) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.className = "cm-frontmatter-key";
      th.textContent = key;
      const td = document.createElement("td");
      td.className = "cm-frontmatter-value";
      td.textContent = value;
      tr.appendChild(th);
      tr.appendChild(td);
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
