import { WidgetType } from "@codemirror/view";

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
    code.textContent = this.code;
    pre.appendChild(code);
    return pre;
  }
  ignoreEvent() {
    return false; // let a click place the caret → reveals the raw source
  }
}
