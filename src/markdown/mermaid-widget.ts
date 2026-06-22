import { WidgetType } from "@codemirror/view";
import svgPanZoom from "svg-pan-zoom";
import { boundedCache } from "./bounded-cache";
import { panZoomSetting, themeForceSetting } from "../settings/app";
import type { Theme } from "../theme";

type Mermaid = typeof import("mermaid").default;
type MermaidTheme = "dark" | "default";

/** The "which mermaid theme do we render with" rule in one named place. The app
 *  theme is the baseline (light → mermaid "default", dark → "dark"), but the
 *  themeForce setting overrides it: `dark`/`light` pin the diagram theme
 *  regardless of the app, `follow` (default) tracks the app. Both loadMermaid
 *  and refreshMermaidTheme route through here so the rule lives once. Pure. */
export function effectiveMermaidTheme(appTheme: Theme): MermaidTheme {
  switch (themeForceSetting.get()) {
    case "dark":
      return "dark";
    case "light":
      return "default";
    default:
      return appTheme === "light" ? "default" : "dark";
  }
}

// The last app theme passed to refreshMermaidTheme, remembered so the themeForce
// self-subscription can re-bake without main.ts handing it the app theme again.
let lastAppTheme: Theme = "dark";

// Mermaid is ~1.3MB — load it only when the first diagram renders.
let mermaidLoader: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  if (!mermaidLoader)
    mermaidLoader = import("mermaid").then(({ default: m }) => {
      const appTheme: Theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      lastAppTheme = appTheme;
      m.initialize({ startOnLoad: false, securityLevel: "strict", theme: effectiveMermaidTheme(appTheme) });
      return m;
    });
  return mermaidLoader;
}

// SVG cache keyed by diagram source: reveal/unreveal cycles and scrolling
// must not re-run the mermaid renderer.
const svgCache = boundedCache<string, string>(50);

let idSeq = 0;

// Bumped whenever the theme changes. Mermaid bakes theme colors into the SVG,
// so a theme switch must re-render every diagram; widgets compare this version
// in eq() so CM redraws them even though the source code is unchanged.
let themeVersion = 0;

/** Re-theme mermaid live (no page reload): clear the cache, re-init mermaid with
 *  the effective theme, and bump the version so widgets re-render. The app theme
 *  is passed in (a SSOT sink) rather than pulled from the DOM, and remembered so
 *  the themeForce self-subscription can re-bake with it. */
export function refreshMermaidTheme(theme: Theme) {
  lastAppTheme = theme;
  themeVersion++;
  svgCache.clear();
  if (mermaidLoader) {
    mermaidLoader.then((m) =>
      m.initialize({ startOnLoad: false, securityLevel: "strict", theme: effectiveMermaidTheme(theme) }),
    );
  }
}

// themeForce is a mermaid-domain rule, so the widget layer owns its re-bake:
// when the user pins/unpins the diagram theme, re-bake against the last app
// theme. The redraw dispatch (refreshBlocks) is main.ts's job since only it
// holds the editor handle — main stays free of mermaid theme knowledge.
themeForceSetting.subscribe(() => refreshMermaidTheme(lastAppTheme));

// Height of the most recently rendered diagram. When a re-render misses the
// cache (the source was edited), we reserve this height on the new host while
// mermaid renders async, so leaving the block doesn't collapse the box to 0 and
// jump the page. Cleared once the real height is set.
let lastHeight = 0;

/** Explicit pixel size declared on the diagram's first line (`300, 400`); `null`
 *  on an axis means "use natural size". Parsed in features/mermaid.ts. */
export interface MermaidDims {
  width: number | null;
  height: number | null;
}

export class MermaidWidget extends WidgetType {
  readonly version = themeVersion; // captured at construction; see refreshMermaidTheme
  // Snapshot the pan/zoom setting at construction so a live toggle makes eq()
  // false → CM re-creates the host → initPanZoom re-runs with the new value.
  // (refreshBlocks alone wouldn't redraw an eq()-equal widget.)
  readonly panZoom = panZoomSetting.get();
  constructor(
    readonly code: string,
    readonly dims: MermaidDims = { width: null, height: null },
  ) {
    super();
  }
  eq(o: MermaidWidget) {
    return (
      o.code === this.code &&
      o.version === this.version &&
      o.panZoom === this.panZoom &&
      o.dims.width === this.dims.width &&
      o.dims.height === this.dims.height
    );
  }
  toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-mermaid";
    applyDimensions(host, this.dims);
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
          svgCache.put(this.code, svg);
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
    prepareNaturalSvg(el);
    // svg-pan-zoom must initialize on a host that already has a width. toDOM
    // runs BEFORE CM attaches the host, so a synchronous init fits the diagram
    // to a 0-width box and it renders invisible (the re-render-after-edit bug).
    whenLaidOut(host, () => {
      // Pin the host to the diagram's DISPLAYED height BEFORE pan-zoom transforms
      // the SVG (and strips the viewBox we read from), so the box matches the
      // actual drawing — no empty band — AND svg-pan-zoom's height:100% has a
      // definite box to fill (otherwise the host collapses and the diagram is
      // clipped).
      fitHostHeight(host, el, this.dims);
      initPanZoom(host, el);
      // Click-to-edit is handled centrally in live-preview/core (a capture-phase
      // listener that beats svg-pan-zoom), so the widget stays mode-agnostic.
      host.dispatchEvent(new CustomEvent("mermaid-rendered", { bubbles: true }));
    });
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

/** Apply an explicit pixel size declaration to the host. A declared axis pins
 *  the host to that many px and lets it scroll if the diagram overflows; an
 *  undeclared axis (`null`) is left to natural sizing + the CSS column cap. */
function applyDimensions(host: HTMLElement, dims: MermaidDims): void {
  if (dims.width !== null) {
    host.style.width = `${dims.width}px`;
    host.style.overflowX = "auto";
  }
  if (dims.height !== null) {
    host.style.height = `${dims.height}px`;
    host.style.overflowY = "auto";
  }
}

/** Keep mermaid's natural SVG sizing intact for natural-size display. Unlike the
 *  old stretch-to-fill normalize (which removed height + forced width/height:100%
 *  + max-width:none), this leaves mermaid's inline width/height/max-width:<natural>px
 *  untouched, so the diagram renders at its natural size and the CSS column cap
 *  (`max-width:100%`) downscales only when it's wider than the column.
 *
 *  No-op on the SVG today: natural sizing means there's nothing to strip. Kept as
 *  a named seam so the "prepare the SVG before pan-zoom" step stays explicit and
 *  any future per-axis fixups (RTL, viewBox repair) land in one place. */
function prepareNaturalSvg(_el: SVGSVGElement): void {
  // intentionally leaves mermaid's inline sizing as-is
}

/** Pure query: the height the diagram actually occupies once the CSS column cap
 *  (`max-width:100%`) has downscaled it. Computed from the SVG's viewBox aspect
 *  ratio times the SVG's *actual displayed width* — NOT the host's clientWidth.
 *
 *  Why the SVG's width and not the host's: `.cm-mermaid` is `display:flex;
 *  justify-content:center`, so the host's clientWidth is the full column width.
 *  A diagram narrower than the column is centered and stays at its natural
 *  (narrower) width — using the host width would overestimate its height and
 *  reintroduce the empty band. The SVG's own getBoundingClientRect().width is the
 *  truth for both cases: downscaled-to-column (wide) and natural (narrow).
 *
 *  Fallback when there's no usable viewBox (e.g. pan-zoom already stripped it, or
 *  a malformed SVG): the host's current rendered height. The result is clamped to
 *  > 0 so the host never collapses (render-smoke 0-height guard, d16d8e8). */
export function displayedDiagramHeight(host: HTMLElement, el: SVGSVGElement): number {
  const vb = parseViewBox(el.getAttribute("viewBox"));
  const shownWidth = el.getBoundingClientRect().width;
  if (vb && vb.w > 0 && vb.h > 0 && shownWidth > 0) {
    return shownWidth * (vb.h / vb.w);
  }
  return host.getBoundingClientRect().height;
}

/** Parse an SVG `viewBox="minX minY w h"` into width/height, or `null` if absent
 *  or malformed. Only w/h matter for aspect-ratio sizing. */
function parseViewBox(attr: string | null): { w: number; h: number } | null {
  if (!attr) return null;
  const parts = attr.trim().split(/[\s,]+/).map(Number);
  if (parts.length < 4 || parts.some((n) => Number.isNaN(n))) return null;
  return { w: parts[2], h: parts[3] };
}

/** Pin the host to the diagram's *displayed* height so the box matches the actual
 *  drawing and no empty band remains. svg-pan-zoom sets the SVG to
 *  width/height:100%, so the host MUST carry a definite height or the SVG resolves
 *  100% against an auto-height parent and collapses — clipping the diagram. A
 *  `dims.height` declaration already pinned the host (applyDimensions), so leave
 *  that case alone. Also records `lastHeight` so the NEXT async render can reserve
 *  a placeholder and not jump the page.
 *
 *  CQS: the displayed height is computed by the pure query displayedDiagramHeight;
 *  this command only writes it. The viewBox must be read here, BEFORE initPanZoom
 *  strips it. */
function fitHostHeight(host: HTMLElement, el: SVGSVGElement, dims: MermaidDims): void {
  host.style.minHeight = ""; // real height present → drop the reserved placeholder
  if (dims.height !== null) return; // explicit px height already set by applyDimensions
  const h = displayedDiagramHeight(host, el);
  if (h > 0) {
    host.style.height = `${h}px`;
    lastHeight = h;
  }
}

/** Run `cb` once the host is connected and laid out (nonzero width). Gives up
 *  after ~120 frames if the host never lays out. */
function whenLaidOut(host: HTMLElement, cb: () => void): void {
  let frames = 0;
  const tick = () => {
    if (!host.isConnected) return; // widget dropped before it ever laid out
    if (host.clientWidth === 0 && frames++ < 120) {
      requestAnimationFrame(tick);
      return;
    }
    cb();
  };
  requestAnimationFrame(tick);
}

/** Build the interactive viewer on a laid-out host: svg-pan-zoom keeping the
 *  diagram at its natural size (fit:false), re-center on container resize until
 *  the user pans/zooms, dblclick zoom toggle, and Ctrl/Cmd-wheel zoom (plain
 *  wheel stays page scroll). Natural sizing makes fit() a no-op so we only
 *  re-center; no aspect is needed. */
function initPanZoom(host: HTMLElement, el: SVGSVGElement): void {
  // Pan/zoom is opt-out via the SSOT setting: when off, the diagram renders
  // static (no svg-pan-zoom, no wheel/dblclick handlers) so it scrolls like text.
  if (panZoomSetting.get() === "off") return;
  const pz = svgPanZoom(el, {
    panEnabled: true,
    zoomEnabled: true,
    mouseWheelZoomEnabled: false, // wheel zoom gated on Ctrl/Cmd below
    dblClickZoomEnabled: false,
    fit: false, // keep mermaid's natural size; pan-zoom only adds interaction
    center: true,
  });
  (host as unknown as { __pz?: { destroy(): void } }).__pz = pz;

  // Re-center on container resize until the user pans/zooms manually. fit() is
  // dropped: at natural size there's nothing to fit, only to re-center.
  let touched = false;
  el.addEventListener("pointerdown", () => (touched = true), { once: true });
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      pz.resize();
      if (!touched) pz.center();
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
}
