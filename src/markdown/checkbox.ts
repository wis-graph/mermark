import { EditorView, WidgetType } from "@codemirror/view";

/** Replaces a `[ ]`/`[x]` task marker; clicking toggles the source text. */
export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-task-checkbox";
    input.checked = this.checked;
    input.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(input);
      if (!/^\[[ xX]\]$/.test(view.state.sliceDoc(pos, pos + 3))) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? " " : "x" } });
    });
    return input;
  }
  ignoreEvent() {
    return true;
  }
}
