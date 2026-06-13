import { WidgetType } from "@codemirror/view";
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

// Height of the most recently rendered diagram. When a re-render misses the
// cache (the source was edited), we reserve this height on the new host while
// mermaid renders async, so leaving the block doesn't collapse the box to 0 and
// jump the page. Cleared once the real height is set.
let lastHeight = 0;

export class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.code === this.code;
  }
  toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-mermaid";
    const cached = svgCache.get(this.code);
    if (cached !== undefined) {
      this.applySvg(host, cached);
    } else {
      // reserve the last diagram's height so the box doesn't collapse (and jump
      // the page) during the async render after an edit
      if (lastHeight) host.style.minHeight = `${lastHeight}px`;
      loadMermaid()
        .then((mermaid) => mermaid.render(`mmd-${idSeq++}`, this.code))
        .then(({ svg }) => {
          cachePut(this.code, svg);
          this.applySvg(host, svg);
        })
        .catch((err) => {
          host.style.minHeight = "";
          host.innerHTML = "";
          const pre = document.createElement("pre");
          pre.className = "cm-mermaid-error";
          pre.textContent = `Mermaid error: ${err?.message ?? err}\n\n${this.code}`;
          host.appendChild(pre);
        });
    }
    return host;
  }
  private applySvg(host: HTMLElement, svg: string) {
    host.innerHTML = svg;
    const el = host.querySelector<SVGSVGElement>("svg");
    if (!el) return;
    // Read the diagram's natural aspect ratio BEFORE svg-pan-zoom strips the
    // viewBox; without it the svg collapses to the 150px replaced-element
    // default and tall diagrams get cropped.
    const vb = (el.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
    const aspect = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb[3] / vb[2] : 0.6;
    el.removeAttribute("height");
    el.style.width = "100%";
    el.style.height = "100%";
    // Mermaid stamps `max-width: <natural width>px` inline on the <svg>, which
    // caps it at the diagram's natural size and leaves it small/left in a wide
    // host. Clear it so the diagram scales to the full container width.
    el.style.maxWidth = "none";

    // Size the host so the whole diagram fits: width-driven height, capped to
    // the window so huge diagrams scale down instead of overflowing.
    const fitHeight = () => {
      const w = host.clientWidth || 600;
      const cap = (window.innerHeight || 800) * 0.85;
      const h = Math.max(80, Math.min(w * aspect, cap));
      host.style.height = `${h}px`;
      host.style.minHeight = ""; // real height set → drop the reserved placeholder
      lastHeight = h;
    };

    // svg-pan-zoom must initialize on a host that already has a width. toDOM
    // runs BEFORE CM attaches the host, so a synchronous init fits the diagram
    // to a 0-width box and it renders invisible (the re-render-after-edit bug).
    // Defer until the host is connected and laid out.
    let frames = 0;
    const setup = () => {
      if (!host.isConnected) return; // widget dropped before it ever laid out
      if (host.clientWidth === 0 && frames++ < 120) {
        requestAnimationFrame(setup);
        return;
      }
      fitHeight();
      const pz = svgPanZoom(el, {
        panEnabled: true,
        zoomEnabled: true,
        mouseWheelZoomEnabled: false, // wheel zoom gated on Ctrl/Cmd below
        dblClickZoomEnabled: false,
        fit: true,
        center: true,
      });
      (host as unknown as { __pz?: { destroy(): void } }).__pz = pz;

      // Refit on container resize until the user pans/zooms manually.
      let touched = false;
      el.addEventListener("pointerdown", () => (touched = true), { once: true });
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => {
          fitHeight();
          pz.resize();
          if (!touched) {
            pz.fit();
            pz.center();
          }
        });
        ro.observe(host);
        (host as unknown as { __ro?: ResizeObserver }).__ro = ro;
      }
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
      // Click-to-edit is handled centrally in live-preview/core (a capture-phase
      // listener that beats svg-pan-zoom), so the widget stays mode-agnostic.
      host.dispatchEvent(new CustomEvent("mermaid-rendered", { bubbles: true }));
    };
    requestAnimationFrame(setup);
  }
  ignoreEvent() {
    return true;
  }
  destroy(dom: HTMLElement): void {
    (dom as unknown as { __ro?: ResizeObserver }).__ro?.disconnect();
    const pz = (dom as unknown as { __pz?: { destroy(): void } }).__pz;
    try {
      pz?.destroy();
    } catch {
      /* already gone */
    }
  }
}
