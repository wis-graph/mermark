import { EditorView, WidgetType } from "@codemirror/view";
import svgPanZoom from "svg-pan-zoom";

type Mermaid = typeof import("mermaid").default;

// Mermaid is ~1.3MB — load it only when the first diagram renders.
let mermaidLoader: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  if (!mermaidLoader)
    mermaidLoader = import("mermaid").then(({ default: m }) => {
      const light = document.documentElement.dataset.theme === "light";
      m.initialize({ startOnLoad: false, securityLevel: "strict", theme: light ? "default" : "dark" });
      return m;
    });
  return mermaidLoader;
}

// SVG cache keyed by diagram source: reveal/unreveal cycles and scrolling
// must not re-run the mermaid renderer.
const svgCache = new Map<string, string>();
const CACHE_MAX = 50;
function cachePut(code: string, svg: string) {
  if (svgCache.size >= CACHE_MAX) {
    const first = svgCache.keys().next().value;
    if (first !== undefined) svgCache.delete(first);
  }
  svgCache.set(code, svg);
}

let idSeq = 0;

export class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.code === this.code;
  }
  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-mermaid";
    const cached = svgCache.get(this.code);
    if (cached !== undefined) {
      this.applySvg(host, cached, view);
    } else {
      loadMermaid()
        .then((mermaid) => mermaid.render(`mmd-${idSeq++}`, this.code))
        .then(({ svg }) => {
          cachePut(this.code, svg);
          this.applySvg(host, svg, view);
        })
        .catch((err) => {
          host.innerHTML = "";
          const pre = document.createElement("pre");
          pre.className = "cm-mermaid-error";
          pre.textContent = `Mermaid error: ${err?.message ?? err}\n\n${this.code}`;
          host.appendChild(pre);
        });
    }
    return host;
  }
  private applySvg(host: HTMLElement, svg: string, view: EditorView) {
    host.innerHTML = svg;
    const el = host.querySelector<SVGSVGElement>("svg");
    if (!el) return;
    el.removeAttribute("height");
    el.style.width = "100%";
    const pz = svgPanZoom(el, {
      panEnabled: true,
      zoomEnabled: true,
      mouseWheelZoomEnabled: false, // wheel zoom gated on Ctrl/Cmd below
      dblClickZoomEnabled: false,
      fit: true,
      center: true,
    });
    (host as unknown as { __pz?: { destroy(): void } }).__pz = pz;
    let zoomed = false;
    host.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (zoomed) {
        pz.reset();
        zoomed = false;
      } else {
        pz.zoomBy(2);
        zoomed = true;
      }
    });
    host.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return; // plain wheel = page scroll
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        pz.zoomAtPointBy(e.deltaY < 0 ? 1.15 : 0.87, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      },
      { passive: false },
    );
    // Cmd/Ctrl+click → edit the diagram source (plain click pans/zooms)
    host.addEventListener("mousedown", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(host) } });
    });
    host.dispatchEvent(new CustomEvent("mermaid-rendered", { bubbles: true }));
  }
  ignoreEvent() {
    return true;
  }
  destroy(dom: HTMLElement): void {
    const pz = (dom as unknown as { __pz?: { destroy(): void } }).__pz;
    try {
      pz?.destroy();
    } catch {
      /* already gone */
    }
  }
}
