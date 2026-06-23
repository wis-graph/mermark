import { WidgetType } from "@codemirror/view";
import { icon, type IconName } from "../icons";

/** Renders a callout head `[!type] title` as an icon + title chip. The widget is
 *  the live-preview face of the head; when the caret enters the head line, core
 *  drops it (the spec is `conceal: true`) and the raw `[!type] title` reappears
 *  for editing. Pure toDOM: builds an SVG node + a text span, touches no external
 *  state. */
export class CalloutHeadWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly iconName: IconName,
    readonly title: string,
  ) {
    super();
  }

  // Reused while key + title are unchanged, so a selection move alone never
  // rebuilds the icon SVG. iconName is derived from key, so comparing key suffices.
  eq(o: CalloutHeadWidget) {
    return o.key === this.key && o.title === this.title;
  }

  toDOM() {
    const root = document.createElement("span");
    root.className = "cm-callout-head-widget";
    const iconBox = document.createElement("span");
    iconBox.className = "cm-callout-icon";
    iconBox.appendChild(icon(this.iconName));
    const titleEl = document.createElement("span");
    titleEl.className = "cm-callout-title";
    titleEl.textContent = this.title;
    root.appendChild(iconBox);
    root.appendChild(titleEl);
    return root;
  }
}
