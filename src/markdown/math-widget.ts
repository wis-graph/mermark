import { WidgetType } from "@codemirror/view";
import { boundedCache } from "./bounded-cache";

type Katex = typeof import("katex").default;

let katexLoader: Promise<Katex> | null = null;
function loadKatex(): Promise<Katex> {
  if (!katexLoader) katexLoader = import("katex").then((m) => m.default);
  return katexLoader;
}

// Rendered-HTML cache so reveal/unreveal cycles don't re-typeset.
const htmlCache = boundedCache<string, string>(200);

export class KatexWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super();
  }
  eq(o: KatexWidget) {
    return o.tex === this.tex && o.display === this.display;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math-block" : "cm-math-inline";
    const key = (this.display ? "D" : "I") + this.tex;
    const hit = htmlCache.get(key);
    if (hit !== undefined) {
      el.innerHTML = hit;
    } else {
      el.textContent = this.display ? this.tex : `$${this.tex}$`;
      loadKatex()
        .then((katex) => {
          const html = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false });
          htmlCache.put(key, html);
          el.innerHTML = html;
        })
        .catch(() => {
          el.textContent = `$${this.tex}$`;
        });
    }
    // Click→source is handled centrally in live-preview/core (clickEntry, a
    // capture-phase listener on .cm-math-block, edit-mode only). Read mode is
    // preview — a click does nothing.
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
