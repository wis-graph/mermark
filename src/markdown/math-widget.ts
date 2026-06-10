import { EditorView, WidgetType } from "@codemirror/view";

type Katex = typeof import("katex").default;

let katexLoader: Promise<Katex> | null = null;
function loadKatex(): Promise<Katex> {
  if (!katexLoader) katexLoader = import("katex").then((m) => m.default);
  return katexLoader;
}

// Rendered-HTML cache so reveal/unreveal cycles don't re-typeset.
const htmlCache = new Map<string, string>();
const CACHE_MAX = 200;
function cachePut(key: string, html: string) {
  if (htmlCache.size >= CACHE_MAX) {
    const first = htmlCache.keys().next().value;
    if (first !== undefined) htmlCache.delete(first);
  }
  htmlCache.set(key, html);
}

export class KatexWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super();
  }
  eq(o: KatexWidget) {
    return o.tex === this.tex && o.display === this.display;
  }
  toDOM(view: EditorView) {
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
          cachePut(key, html);
          el.innerHTML = html;
        })
        .catch(() => {
          el.textContent = `$${this.tex}$`;
        });
    }
    if (this.display) {
      // click a rendered math block → cursor into its source
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const pos = view.posAtDOM(el);
        view.dispatch({ selection: { anchor: pos } });
      });
    }
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
