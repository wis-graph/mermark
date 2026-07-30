// The image viewer: an in-content pane for explorer image clicks (full-pane
// rewrite, _workspace/01_architect_design.md — supersedes R11's body-level
// lightbox). Built on the shared `openViewerShell` (in-content pane /
// capture-phase Esc / `.editor-host` hidden / last-focus restore / the zoom
// state machine) instead of duplicating that chrome. It makes zero
// decorations: the render-smoke invariant ("block decorations come from a
// StateField") has no intersection here, and the ⌘± zoom measure guard is
// untouched. Built lazily (only on an explorer image click), torn down
// completely on close() — no persistent DOM/listeners between opens.
//
// This viewer has no native scroll container — position is expressed purely
// as `attachPanZoom`'s CSS transform (see mermaid-widget.ts), so keyboard
// and wheel panning both go through its `panBy` primitive instead of
// scrollTop/scrollLeft.
import { attachPanZoom } from "../../markdown/mermaid-widget";
import { resolveImageUrl } from "../../markdown/image";
import { basename, dirOf } from "../../document/path";
import { openViewerShell } from "./shell";
import type { ViewerHandle } from "./registry";

export type ImageViewerHandle = ViewerHandle;

/** The caption text for a loaded image: filename + its natural pixel size, the
 *  single "what does the caption say" rule so onload and any future caller
 *  agree on the format. Pure query. */
function loadedCaption(name: string, img: HTMLImageElement): string {
  return `${name} — ${img.naturalWidth}×${img.naturalHeight}`;
}

/** Scale the image's rendered width to `factor` × its natural width (design
 *  §B's per-viewer BEHAVIOR table: "레이아웃 폭 스케일"). At `factor === 1`
 *  (fit, the default), the inline overrides are REMOVED entirely so the CSS
 *  fit rule (`.image-viewer-img`'s `max-width/max-height: 100%`, styles.css)
 *  takes back over — never re-declared here, so there is exactly one "what
 *  does fit mean" rule. `attachPanZoom`'s own transform (pan) is a DIFFERENT
 *  CSS property (`transform`, not `width`) so the two coexist without a
 *  writer conflict: pan moves/scales the element visually, this changes its
 *  LAYOUT box. Skips the ≠1 branch before the image has ever loaded
 *  (`naturalWidth` is still 0) — a zoom click can only reach a live width
 *  once there is one to multiply. Command (void). */
function applyImageZoom(img: HTMLImageElement, factor: number): void {
  if (factor === 1) {
    img.style.removeProperty("width");
    img.style.removeProperty("max-width");
    img.style.removeProperty("max-height");
    return;
  }
  if (!img.naturalWidth) return;
  img.style.maxWidth = "none";
  img.style.maxHeight = "none";
  img.style.width = `${img.naturalWidth * factor}px`;
}

/** One arrow-key pan step, in CSS pixels — named so all four arrow keys agree
 *  on a single step size (design: "60px 상당"). */
const ARROW_PAN_STEP_PX = 60;

/** PageUp/PageDown pan as a fraction of the stage's visible height. The
 *  conventional native-scroll ratio (< 1.0 on purpose, so a sliver of the
 *  previous screen stays visible across the page jump — helps orient the eye). */
const PAGE_PAN_RATIO = 0.9;

/** Assumed CSS-pixel height of one wheel "line" when a platform reports
 *  `DOM_DELTA_LINE` instead of raw pixels — the value browsers themselves use
 *  for line-mode wheel scrolling. Only exercised on platforms that don't
 *  report `DOM_DELTA_PIXEL` (macOS/WKWebView, this app's actual runtime,
 *  always does). */
const WHEEL_LINE_HEIGHT_PX = 16;

/** Normalize a `WheelEvent`'s raw delta to CSS pixels. `deltaMode` says what
 *  unit `delta` is actually in (WHATWG UI Events §wheel-events) — treating a
 *  LINE or PAGE delta as pixels would move the content by a handful of
 *  pixels per wheel notch on any platform that reports those modes.
 *  `DOM_DELTA_PIXEL` (0, the common case) passes through unchanged; `
 *  DOM_DELTA_LINE` (1) scales by `WHEEL_LINE_HEIGHT_PX`; `DOM_DELTA_PAGE` (2)
 *  scales by `viewportSize` (a "page" is one screenful of the scrolled
 *  axis). Pure query. */
export function wheelDeltaToPixels(delta: number, deltaMode: number, viewportSize: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * WHEEL_LINE_HEIGHT_PX;
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * viewportSize;
  return delta;
}

/** Open the lightbox for `absPath`. Reuses `resolveImageUrl` (the same local
 *  path → asset URL rule markdown images use) so there is exactly one owner
 *  of that conversion. Returns a handle whose close() restores the page. */
export function openImageViewer(absPath: string): ImageViewerHandle {
  const name = basename(absPath);

  // The checkerboard stage doubles as the pan/zoom host (attachPanZoom reuse —
  // mermaid-widget's handler only ever touches host/element geometry + CSS
  // transform, both of which an <img> supports identically to an <svg>).
  const stage = document.createElement("div");
  stage.className = "image-viewer-stage";
  stage.tabIndex = 0; // focusable — keydown panning targets this element only

  const img = document.createElement("img");
  img.className = "image-viewer-img";
  img.alt = name;
  stage.append(img);

  const shell = openViewerShell({ absPath, paneClass: "image-viewer", content: stage });

  img.onload = () => {
    shell.caption.textContent = loadedCaption(name, img);
  };
  img.onerror = () => {
    // The viewer stays open on a load failure — closing is the user's call,
    // not ours (same "best-effort, never auto-dismiss" stance as ImageWidget's
    // recursive-search fallback).
    shell.caption.textContent = "이미지를 불러올 수 없습니다";
  };
  img.src = resolveImageUrl(absPath, dirOf(absPath));

  // `force: true` for the same reason the mermaid fullscreen lightbox passes
  // it: `panZoomSetting` is a MERMAID setting (설정 › Mermaid › 팬/줌 — it
  // governs diagrams embedded in a document), and honoring it here made an
  // image viewer whose navigation silently vanished when a user turned that
  // switch off — no drag, and after 2026-07-31 no keyboard or wheel scrolling
  // either. A viewer's only way to reach the rest of a zoomed image is not a
  // Mermaid preference.
  const pz = attachPanZoom(stage, img, { force: true });
  shell.onTeardown(() => pz.destroy());

  const unsubscribeZoom = shell.zoom.bind((factor) => applyImageZoom(img, factor));
  shell.onTeardown(unsubscribeZoom);

  // attachPanZoom's own onMouseDown calls e.preventDefault(), so a stage
  // click never focuses it natively — grab focus ourselves on pointerdown
  // (capture phase, so it fires before that preventDefault would matter).
  const onStagePointerDown = () => stage.focus();
  stage.addEventListener("pointerdown", onStagePointerDown, { capture: true });
  shell.onTeardown(() => stage.removeEventListener("pointerdown", onStagePointerDown, { capture: true }));

  // Keydown panning. Bound to the STAGE, never `document` — the explorer
  // sidebar is a non-modal panel that stays alive behind the viewer and owns
  // its own arrow-key navigation; a document-level listener here would steal
  // those keys out from under it.
  const onStageKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // don't fight ⌘±/⌘F etc.
    switch (e.key) {
      // Scroll direction vs. transform direction are inverted, same as any
      // scroll container: "scroll down" reveals content BELOW, which means
      // the content itself moves UP, i.e. translateY DECREASES. ArrowDown/
      // Right (which reveal what's below/to the right) get negative deltas;
      // ArrowUp/Left get positive deltas. Mirrors the wheel handler below.
      case "ArrowUp":
        pz.panBy(0, ARROW_PAN_STEP_PX);
        break;
      case "ArrowDown":
        pz.panBy(0, -ARROW_PAN_STEP_PX);
        break;
      case "ArrowLeft":
        pz.panBy(ARROW_PAN_STEP_PX, 0);
        break;
      case "ArrowRight":
        pz.panBy(-ARROW_PAN_STEP_PX, 0);
        break;
      case "PageUp":
        pz.panBy(0, stage.clientHeight * PAGE_PAN_RATIO);
        break;
      case "PageDown":
        pz.panBy(0, -stage.clientHeight * PAGE_PAN_RATIO);
        break;
      case "Home":
        pz.panBy(0, Infinity); // scroll all the way up
        break;
      case "End":
        pz.panBy(0, -Infinity); // scroll all the way down
        break;
      default:
        return; // not ours — let it bubble (e.g. Escape → shell's capture listener)
    }
    e.preventDefault();
  };
  stage.addEventListener("keydown", onStageKeyDown);
  shell.onTeardown(() => stage.removeEventListener("keydown", onStageKeyDown));

  // Wheel panning: this viewer has no native scroll container (position is
  // pure CSS transform, see the header comment), so a plain wheel would
  // otherwise do nothing. Reuses the same `panBy` primitive as the keyboard
  // path, so the "can't pan past the edge" clamp rule is shared automatically.
  const onStageWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return; // that combo is attachPanZoom's zoom
    // gesture (and a trackpad pinch arrives as a ctrlKey wheel) — not ours.
    const dx = -wheelDeltaToPixels(e.deltaX, e.deltaMode, stage.clientWidth);
    const dy = -wheelDeltaToPixels(e.deltaY, e.deltaMode, stage.clientHeight);
    const applied = pz.panBy(dx, dy);
    // Only claim the event if it actually moved the content — if the image
    // already fits (or is pinned at an edge) panBy clamps to {0, 0}, and we
    // must let the event bubble so scrolling outside the viewer still works.
    if (applied.dx !== 0 || applied.dy !== 0) e.preventDefault();
  };
  stage.addEventListener("wheel", onStageWheel, { passive: false });
  shell.onTeardown(() => stage.removeEventListener("wheel", onStageWheel));

  // onClose forwards the shell teardown so the OPENER learns about closes
  // it did not initiate (Esc / header ✕) — see ViewerHandle.onClose.
  const handle: ImageViewerHandle = { close: () => shell.close(), onClose: (cb) => shell.onTeardown(cb) };

  // Focus the stage AFTER openViewerShell's own closeBtn.focus() (accessibility
  // default) — order matters here, this call must come last, or the shell
  // steals focus back to the close button.
  stage.focus();

  return handle;
}
