import { WidgetType } from "@codemirror/view";

/** Renders a footnote reference [^label] as a superscript chip. */
export class SupWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(o: SupWidget) {
    return o.label === this.label;
  }
  toDOM() {
    const s = document.createElement("sup");
    s.className = "cm-footnote-ref";
    s.textContent = this.label;
    return s;
  }
}
