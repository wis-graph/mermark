import { WidgetType } from "@codemirror/view";

/** An unordered-list bullet, drawn in CSS (not a glyph) so a collapsed item can
 *  carry a halo ring around the dot — a state a font character can't express. */
export class BulletWidget extends WidgetType {
  constructor(readonly collapsed: boolean) {
    super();
  }
  eq(o: BulletWidget) {
    return o.collapsed === this.collapsed;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = this.collapsed ? "cm-bullet cm-bullet-collapsed" : "cm-bullet";
    s.setAttribute("aria-hidden", "true");
    return s;
  }
  ignoreEvent() {
    return false; // let a click place the caret → reveals the raw "- " for editing
  }
}
