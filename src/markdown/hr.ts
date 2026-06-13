import { WidgetType } from "@codemirror/view";

/** A thematic break (`---`) rendered as a horizontal rule. Concealed like the
 *  other markers, so the raw `---` reveals when the caret is on its line. */
export class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement("hr");
    hr.className = "cm-hr";
    return hr;
  }
  ignoreEvent() {
    return false;
  }
}
