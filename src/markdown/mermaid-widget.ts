import { WidgetType } from "@codemirror/view";
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
  // false → CM re-creates the host → attachPanZoom re-runs with the new value.
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
    // CSS transform doesn't change the layout box, so the SVG keeps its natural
    // (or column-capped) size and the host auto-fits it: no height pin needed.
    // Attach the pan/zoom handler synchronously (no laid-out gate required — the
    // handler reads geometry lazily per-event, not at attach time).
    (host as unknown as { __pz?: { destroy(): void } }).__pz = attachPanZoom(host, el);
    // One rAF later the host has laid out: record its rendered height as the
    // anti-jump placeholder for the NEXT async render, and drop any reserved
    // minHeight now that the real diagram is present.
    requestAnimationFrame(() => recordRenderedHeight(host));
    // Click-to-edit is handled centrally in live-preview/core (a capture-phase
    // listener), so the widget stays mode-agnostic.
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

// ---------------------------------------------------------------------------
// CSS-transform pan/zoom (replaces svg-pan-zoom). Events bind to the host
// (.cm-mermaid); the CSS `transform` is applied to the svg with
// transform-origin 0 0 — so the layout box (and thus the host's offsetHeight /
// CM's height map) never changes while panning or zooming. Ported from the
// modern-mermaid PanZoomHandler, trimmed to mermark's (host, svg) pair.
// ---------------------------------------------------------------------------

/** Double-click toggles between this magnification and 1×. A named constant
 *  (not a new SSOT setting): scope-minimal, matching the old `zoomBy(2)`. */
const DOUBLE_CLICK_ZOOM = 2;

interface PanZoomState {
  scale: number;
  translateX: number;
  translateY: number;
}

/** The zoom-bound rule in one place: never shrink below natural size (1×) and
 *  never magnify past 3×. Pure query. */
export function clampZoom(scale: number): number {
  return Math.min(Math.max(1, scale), 3);
}

/** Cursor-anchored zoom: recompute translate so the diagram point under the
 *  cursor stays under the cursor after scaling to `newScale`. Mutates the passed
 *  state's scale/translate in place (the shared math for wheel + dblclick zoom).
 *  `cursorX/Y` are relative to the transform origin (svg's top-left, since
 *  transform-origin is 0 0). Same formula as modern-mermaid:
 *    cursorInSvg = (cursor − translate) / oldScale
 *    translate   = cursor − cursorInSvg × newScale */
export function zoomAtCursor(
  state: PanZoomState,
  cursorX: number,
  cursorY: number,
  newScale: number,
): void {
  const old = state.scale;
  const cursorXInSvg = (cursorX - state.translateX) / old;
  const cursorYInSvg = (cursorY - state.translateY) / old;
  state.scale = newScale;
  state.translateX = cursorX - cursorXInSvg * newScale;
  state.translateY = cursorY - cursorYInSvg * newScale;
}

/** Whether the diagram is currently zoomed or panned away from its resting
 *  state (scale 1, translate 0). The reset button only shows when this is true,
 *  so the rule lives in one named place rather than inline in updateTransform. */
function isTransformed(state: PanZoomState): boolean {
  return state.scale !== 1 || state.translateX !== 0 || state.translateY !== 0;
}

/** Command: write the current pan/zoom state onto the svg as a CSS transform,
 *  and reflect "is this diagram transformed?" onto the host so the reset button
 *  can show/hide via CSS. The single write path for transform, so the
 *  `is-transformed` toggle stays in sync with every pan/zoom/dblclick/reset.
 *  transform-origin stays 0 0 (set once at attach). `withTransition` animates
 *  the dblclick + reset toggle; pan/wheel pass false for instant feedback. */
function updateTransform(
  host: HTMLElement,
  svg: SVGElement,
  state: PanZoomState,
  withTransition = false,
): void {
  svg.style.transition = withTransition ? "transform 0.2s ease-out" : "";
  svg.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
  host.classList.toggle("is-transformed", isTransformed(state));
}

/** Attach CSS-transform pan/zoom to a rendered diagram: drag to pan, Ctrl/Cmd
 *  +wheel to cursor-zoom (plain wheel stays page scroll), dblclick to toggle
 *  zoom. Returns a `destroy()` that removes every listener (host + window). When
 *  the panZoom setting is off the diagram stays fully static (no transform,
 *  no listeners) and destroy() is a safe no-op. Defensive in jsdom: never
 *  throws (getBoundingClientRect/transform are tolerated as missing). */
export function attachPanZoom(host: HTMLElement, svg: SVGElement): { destroy(): void } {
  if (panZoomSetting.get() === "off") return { destroy() {} };

  svg.style.transformOrigin = "0 0";
  const state: PanZoomState = { scale: 1, translateX: 0, translateY: 0 };
  let panning = false;
  let startX = 0;
  let startY = 0;
  let rafId = 0;

  // Pan emits a mousemove stream faster than the 16.7ms frame, so writing the
  // transform on every event repaints the (often large) svg multiple times per
  // frame. These two named commands hold the rAF-coalescing rule in one place
  // (intent-review): mousemove updates `state` synchronously and only SCHEDULES
  // the write, so a burst of moves collapses to one transform write per frame
  // (the rAF reads the LATEST state). mouseup/destroy CANCEL any pending frame
  // so no rAF dangles after the host is gone. Both are void commands (CQS) —
  // state is mutated by the caller, not by these.
  const scheduleTransform = (): void => {
    if (rafId) return; // a frame is already pending → don't double-book
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      updateTransform(host, svg, state); // one write per frame, latest state
    });
  };
  const cancelScheduledTransform = (): void => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  // Explicit affordance for returning to natural size: a small floating button
  // shown (via the host's `is-transformed` class + CSS) only while zoomed/panned.
  // Absolutely positioned, so it lives outside the layout box and never changes
  // host.offsetHeight / CM's height map (ZOOM GUARD).
  const resetBtn = document.createElement("button");
  resetBtn.className = "cm-mermaid-reset";
  resetBtn.type = "button";
  resetBtn.title = "원래 크기로";
  resetBtn.textContent = "⟲";
  host.appendChild(resetBtn);

  const onMouseMove = (e: MouseEvent) => {
    if (!panning) return;
    e.preventDefault();
    state.translateX = e.clientX - startX; // state synchronously, write coalesced
    state.translateY = e.clientY - startY;
    scheduleTransform();
  };
  const onMouseUp = () => {
    panning = false;
    host.style.cursor = "grab";
    // Cancel any pending frame (no leak) and flush the final position once
    // synchronously so the diagram lands exactly where the cursor released, even
    // if mouseup beat the last scheduled frame.
    cancelScheduledTransform();
    updateTransform(host, svg, state);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  };
  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    startX = e.clientX - state.translateX;
    startY = e.clientY - state.translateY;
    panning = true;
    host.style.cursor = "grabbing";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };
  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return; // plain wheel = page scroll
    e.preventDefault();
    const newScale = clampZoom(state.scale + -Math.sign(e.deltaY) * 0.05);
    if (newScale === state.scale) return;
    const rect = host.getBoundingClientRect();
    zoomAtCursor(state, e.clientX - rect.left, e.clientY - rect.top, newScale);
    updateTransform(host, svg, state);
  };
  const onDblClick = (e: MouseEvent) => {
    e.preventDefault();
    if (state.scale === 1) {
      const rect = svg.getBoundingClientRect();
      zoomAtCursor(state, e.clientX - rect.left, e.clientY - rect.top, clampZoom(DOUBLE_CLICK_ZOOM));
    } else {
      state.scale = 1;
      state.translateX = 0;
      state.translateY = 0;
    }
    updateTransform(host, svg, state, true);
  };
  // Swallow the button's own mousedown so it can't start a host pan drag, and on
  // click snap back to natural size (animated). updateTransform clears the host's
  // `is-transformed` class, so the button hides itself again — no extra wiring.
  const onResetMouseDown = (e: MouseEvent) => e.stopPropagation();
  const onResetClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    state.scale = 1;
    state.translateX = 0;
    state.translateY = 0;
    updateTransform(host, svg, state, true);
  };

  host.addEventListener("mousedown", onMouseDown);
  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("dblclick", onDblClick);
  resetBtn.addEventListener("mousedown", onResetMouseDown);
  resetBtn.addEventListener("click", onResetClick);

  return {
    destroy() {
      cancelScheduledTransform(); // no rAF dangles past the widget's life
      host.removeEventListener("mousedown", onMouseDown);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("dblclick", onDblClick);
      resetBtn.removeEventListener("mousedown", onResetMouseDown);
      resetBtn.removeEventListener("click", onResetClick);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    },
  };
}

/** Command: once the diagram has laid out, drop the reserved anti-jump
 *  placeholder (minHeight) and record the host's rendered height so the NEXT
 *  async render (cache miss after an edit) can reserve it and not jump the page.
 *  If offsetHeight is still 0 (jsdom / not yet painted) the placeholder is kept,
 *  preserving the render-smoke 0-height guard. CSS transform doesn't change the
 *  layout box, so host.offsetHeight is the diagram's displayed height. */
export function recordRenderedHeight(host: HTMLElement): void {
  const h = host.offsetHeight;
  if (h > 0) {
    lastHeight = h;
    host.style.minHeight = "";
  }
}
