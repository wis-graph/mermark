import { WidgetType } from "@codemirror/view";
import { icon } from "../icons";

/** How long the copy button shows its result glyph (check on success, an error
 *  title on failure) before reverting to the idle copy icon. Named so the
 *  success and failure paths can't drift out of sync (intent-review). */
const COPY_FEEDBACK_MS = 1500;

/** Command: write `code` to the clipboard and flip the button's icon/title to
 *  reflect the outcome, then revert after `COPY_FEEDBACK_MS`. Void — the DOM
 *  mutation IS the result, there's nothing to hand back to the caller. Never
 *  throws: a rejected clipboard write is a normal, expected outcome (permission
 *  denied, insecure context, …), not a bug — so it's swallowed into the failure
 *  UI rather than surfaced as an unhandled rejection. */
function copyCodeToClipboard(btn: HTMLButtonElement, code: string): void {
  navigator.clipboard.writeText(code).then(
    () => showCopyFeedback(btn, "check", "코드 복사"),
    () => showCopyFeedback(btn, "copy", "복사 실패"),
  );
}

/** Swap the button's icon + title for `COPY_FEEDBACK_MS`, then restore the idle
 *  state. Shared by the success and failure paths so the timing/DOM-swap rule
 *  lives in one place. */
function showCopyFeedback(btn: HTMLButtonElement, glyph: "check" | "copy", title: string): void {
  btn.replaceChildren(icon(glyph));
  btn.title = title;
  setTimeout(() => {
    btn.replaceChildren(icon("copy"));
    btn.title = "코드 복사";
  }, COPY_FEEDBACK_MS);
}

/** Build the per-widget copy-to-clipboard button. Absolutely positioned by CSS
 *  (`.cm-codeblock` is the `position: relative` host), so it never affects the
 *  host's layout box. Its own mousedown/click are stopped from bubbling so a
 *  click can't move the caret or start a text selection — `ignoreEvent` below
 *  tells CM to leave events targeting it alone entirely. */
function createCopyButton(code: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cm-codeblock-copy";
  btn.title = "코드 복사";
  btn.setAttribute("aria-label", "코드 복사");
  btn.appendChild(icon("copy"));
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyCodeToClipboard(btn, code);
  });
  return btn;
}

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
    for (const line of this.code.split("\n")) {
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
    }
    pre.appendChild(code);
    pre.appendChild(createCopyButton(this.code));
    return pre;
  }
  ignoreEvent(event: Event) {
    // Let the copy button own its events entirely; everywhere else in the
    // widget a click should still place the caret → reveal the raw source.
    if ((event.target as HTMLElement | null)?.closest(".cm-codeblock-copy")) return true;
    return false;
  }
}
