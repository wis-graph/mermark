// The mermaid diagram fullscreen lightbox — same architecture as the image
// viewer (image-viewer.ts): an in-content pane built on the shared
// `openViewerShell`, reusing `attachPanZoom` (markdown/mermaid-widget.ts) for
// drag/wheel/dblclick pan-zoom. Unlike the file viewers, there is no absPath
// (a diagram isn't a file) — it supplies an explicit `caption` instead
// (shell.ts's generalized contract). Opened INLINE, not via the viewer
// registry: main.ts calls this directly off the `mermaid-open-fullscreen`
// CustomEvent the widget dispatches (mermaid-widget.ts), the same
// "widget emits an event, chrome listens" pattern `mermaid-rendered` already
// uses to stay markdown-layer-agnostic of chrome.
import { attachPanZoom } from "../../markdown/mermaid-widget";
import { openViewerShell } from "./shell";

/** Scale the diagram's rendered width to `factor` × `fitWidth` — the same
 *  "layout width, not transform" rule image-viewer.ts's `applyImageZoom`
 *  uses, for the same reason: `attachPanZoom`'s own pan/zoom writes the CSS
 *  `transform` property, a DIFFERENT one, so the two writers coexist without
 *  conflict. At `factor === 1` the inline overrides are removed entirely so
 *  the CSS fit rule (`.mermaid-lightbox-stage svg`'s `max-width: 100%`,
 *  styles.css) takes back over — never re-declared here, one "what does fit
 *  mean" rule.
 *
 *  The scale BASE is the `stage`'s current width, measured LIVE on every call
 *  — NOT a once-captured `svg` width. A mermaid `<svg>` renders `width="100%"`
 *  + a viewBox, so it has no fixed pixel width: at rest it fills the stage,
 *  and its intrinsic viewBox width (e.g. 595) is NOT what the user sees (e.g.
 *  1200). Capturing the svg's width was doubly wrong: it caught the pre-layout
 *  intrinsic (595) and then, once zoomed, the svg's own inflated width — so
 *  the first zoom steps SHRANK the diagram (595×1.5 = 892 < the 1200 fit;
 *  measured, Chrome, 2026-07-22). The stage is `overflow:hidden` and stretches
 *  to the pane width, so its `clientWidth` stays the fit width no matter how
 *  large the svg inside it grows — a stable base with no capture-timing race.
 *  A `0` base (stage not laid out) is a defensive no-op. Command (void). */
function applyMermaidZoom(svg: SVGSVGElement, stage: HTMLElement, factor: number): void {
  if (factor === 1) {
    svg.style.removeProperty("width");
    svg.style.removeProperty("max-width");
    return;
  }
  const base = stage.clientWidth;
  if (!base) return;
  svg.style.maxWidth = "none";
  svg.style.width = `${base * factor}px`;
}

/** Open the mermaid fullscreen lightbox for an already-rendered diagram.
 *  `svgHtml` is the diagram's live `outerHTML` (self-contained — the current
 *  theme is already baked in), exactly the widget's
 *  `mermaid-open-fullscreen` event detail. Inline call, not a registered
 *  viewer: a diagram isn't a file, so there is no `ViewerHandle` for a caller
 *  to hold — Esc / the shell's own ✕ close it like any other viewer pane. */
export function openMermaidLightbox(svgHtml: string): void {
  const stage = document.createElement("div");
  stage.className = "mermaid-lightbox-stage";
  stage.innerHTML = svgHtml;
  const svg = stage.querySelector<SVGSVGElement>("svg");

  const shell = openViewerShell({ caption: "다이어그램", paneClass: "mermaid-lightbox", content: stage });

  // A defensive no-op path (mirrors image-viewer's onerror stance): if the
  // dispatched markup somehow contained no <svg>, the shell still opens (an
  // empty stage) rather than throwing — pan/zoom and the zoom controls simply
  // have nothing to drive.
  if (!svg) return;

  // The dispatched `svg.outerHTML` is a snapshot of the INLINE diagram, which
  // may have been pan/zoomed — attachPanZoom writes `transform`/
  // `transformOrigin`/`transition` as inline styles, and outerHTML carries
  // them in verbatim. Left as-is, the lightbox would open at the inline
  // diagram's leftover zoom/pan instead of a clean fit. Clear them so the
  // lightbox starts at rest; the fresh attachPanZoom below re-establishes its
  // own origin and identity state. (single "the lightbox opens at fit" rule.)
  svg.style.removeProperty("transform");
  svg.style.removeProperty("transform-origin");
  svg.style.removeProperty("transition");

  // force: true — fullscreen's whole point is precise inspection, so pan/zoom
  // stays on here regardless of the panZoomSetting gating the small inline
  // diagram.
  const pz = attachPanZoom(stage, svg, { force: true });
  shell.onTeardown(() => pz.destroy());

  // The title-bar −/+ zoom scales the svg's layout width against the STAGE's
  // live width (applyMermaidZoom measures it per call — no capture-timing
  // race). Same coexistence as the image viewer: this writes `width`,
  // attachPanZoom writes `transform`, so −/+ magnify and drag pans, together.
  const unsubscribeZoom = shell.zoom.bind((factor) => applyMermaidZoom(svg, stage, factor));
  shell.onTeardown(unsubscribeZoom);
}
