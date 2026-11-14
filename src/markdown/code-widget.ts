import { WidgetType } from "@codemirror/view";
import { createCopyButton } from "./copy-button";
import { highlightedLines, highlightedLinesNow } from "./code-highlight";

/** How many ch a tab-stop counts as for the hanging-indent measurement below —
 *  the same 2ch tab-to-space equivalence the rest of the editor's monospace
 *  metrics assume. */
const TAB_WIDTH_CH = 2;

/** The soft-wrap hanging-indent rule, named once: a wrapped continuation of a
 *  code line should tuck in 2ch deeper than that line's own leading
 *  whitespace, so it reads as "still part of this line" instead of resetting
 *  to column 0. Counts leading spaces as 1ch and leading tabs as TAB_WIDTH_CH,
 *  stopping at the first non-whitespace character (an all-whitespace line
 *  still terminates — there is no non-whitespace char to find, so the whole
 *  line counts as "leading"). Pure query. */
export function codeHangCh(line: string): number {
  let leading = 0;
  for (const ch of line) {
    if (ch === "\t") leading += TAB_WIDTH_CH;
    else if (ch === " ") leading += 1;
    else break;
  }
  return leading + 2;
}

/** A fenced code block rendered as a styled box (like the mermaid/table/math
 *  block widgets). The raw ```lang … ``` source is revealed for editing when the
 *  caret enters the block — handled by the shared block-entry navigation. */
export class CodeBlockWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly lang: string,
  ) {
    super();
  }
  eq(o: CodeBlockWidget) {
    return o.code === this.code && o.lang === this.lang;
  }
  toDOM() {
    const pre = document.createElement("pre");
    pre.className = "cm-codeblock";
    if (this.lang) pre.dataset.lang = this.lang;
    const code = document.createElement("code");
    // One row per SOURCE line (not one <code> textContent blob): a block-level
    // row is what lets the hanging-indent CSS (padding + negative text-indent,
    // styles.css's .cm-code-row) apply PER LINE — each wrapped line's hang
    // column depends on THAT line's own leading whitespace, which a single
    // shared text node can't express. The clipboard copy button still uses
    // `this.code` (the original joined string), so row-splitting is a
    // toDOM-only presentation detail — eq()/copy are unaffected.
    const sourceLines = this.code.split("\n");
    const rows: HTMLElement[] = [];
    for (const line of sourceLines) {
      const row = document.createElement("span");
      row.className = "cm-code-row";
      row.style.setProperty("--code-hang", `${codeHangCh(line)}ch`);
      if (line === "") {
        // A content-less block-level span has no line box and collapses to 0
        // height — an empty source line would otherwise vanish visually in
        // read mode (2026-07-12 audit: regression from the per-row switch —
        // the old single-textContent+pre-wrap render preserved blank lines
        // for free). A <br> forces a line box without depending on the newer
        // `1lh` CSS unit, whose WKWebView support isn't guaranteed.
        row.appendChild(document.createElement("br"));
      } else {
        row.textContent = line;
      }
      code.appendChild(row);
      rows.push(row);
    }
    // Highlighting: sync if hljs/cache already has it, else plain now and
    // swapped in when the lazy hljs import resolves (rows are mutated in place
    // so the layout never jumps). Only hljs's own escaped output hits innerHTML.
    const apply = (htmls: string[] | null) => {
      if (!htmls || htmls.length !== rows.length) return;
      htmls.forEach((html, i) => {
        if (sourceLines[i] !== "") rows[i].innerHTML = html;
      });
    };
    const now = highlightedLinesNow(this.lang, this.code);
    if (now) apply(now);
    else void highlightedLines(this.lang, this.code).then(apply, () => {});
    pre.appendChild(code);
    pre.appendChild(createCopyButton(this.code, "코드 복사", "cm-codeblock-copy"));
    return pre;
  }
  ignoreEvent(event: Event) {
    // Let the copy button own its events entirely; everywhere else in the
    // widget a click should still place the caret → reveal the raw source.
    if ((event.target as HTMLElement | null)?.closest(".cm-copy-btn")) return true;
    return false;
  }
}
