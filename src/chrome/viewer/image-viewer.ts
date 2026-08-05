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
import { resolveImageUrl, isRemoteSrc } from "../../markdown/image";
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

/** The last non-empty `/`-separated segment of a URL pathname — e.g.
 *  "/img/cat.png" → "cat.png", "/img/cat.png/" → "cat.png". Pure query. */
function lastPathSegment(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** What the viewer should call `source` in its caption/aria-label — the
 *  single "what does this image's name say" rule for BOTH a local path and a
 *  remote/data URL (image.ts's `resolvedPath` priority already guarantees
 *  this always matches what the widget showed). A local absolute path uses
 *  its basename, unchanged from before this widened contract. A remote URL
 *  uses the last non-empty path segment, falling back to the hostname for a
 *  bare-domain URL with no path (`lastPathSegment` returns ""). A `data:` URL
 *  carries no filename at all — a fixed placeholder, not an attempt to parse
 *  one out of the payload. A TOTAL function, deliberately: `isRemoteSrc` only
 *  checks the `https?://`/`data:` prefix, not well-formedness, so a degenerate
 *  target (a stray `![](https://)` with no host) still passes that test but
 *  makes `new URL` throw — caught here and given the same "nothing to name"
 *  placeholder as `data:`, rather than propagating past `openImageViewer`'s
 *  first line where a throw would abandon `placeInViewerSlot` mid-assignment
 *  (closed the old viewer, never stored the new handle). Pure query. */
export function imageDisplayName(source: string): string {
  if (source.startsWith("data:")) return "이미지";
  if (isRemoteSrc(source)) {
    try {
      const url = new URL(source);
      return lastPathSegment(url.pathname) || url.hostname;
    } catch {
      return "이미지"; // malformed remote target — nothing sensible to name it
    }
  }
  return basename(source);
}

/** What `<img>.src` should be for `source` — a remote/data URL passes through
 *  UNCHANGED (it has no `baseDir` to resolve against; re-resolving it would
 *  corrupt it), a local absolute path goes through the same `resolveImageUrl`
 *  markdown images use so the two code paths agree on what a "local path"
 *  even means. Pure query. */
export function imageViewerUrl(source: string): string {
  if (isRemoteSrc(source)) return source;
  return resolveImageUrl(source, dirOf(source));
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

/** One axis's position-indicator geometry — the same arithmetic a native
 *  overlay scrollbar uses: `sizeRatio` (0~1) is how much of the full content
 *  is visible at once (thumb length / track length), `startRatio` (0~1) is
 *  how far into the content the visible window currently starts (thumb
 *  offset / track length). `null` when the content doesn't overflow the host
 *  on this axis at all — nothing to indicate, same size, or smaller.
 *
 *  `startRatio` is clamped to [0,1] on purpose: mouse DRAG is deliberately
 *  left unclamped by `panBy`'s design (the mouse itself bounds how far a
 *  user drags — see attachPanZoom's doc), so the content can briefly sit
 *  outside the host's edges mid-drag. Without the clamp here the thumb would
 *  slide off its own track at that moment; `sizeRatio` needs no clamp since
 *  it's a genuine ratio of two positive lengths (host is always ≤ content by
 *  the guard above). Pure query. */
export function panIndicatorFor(
  content: { start: number; end: number },
  host: { start: number; end: number },
): { sizeRatio: number; startRatio: number } | null {
  const contentLen = content.end - content.start;
  const hostLen = host.end - host.start;
  if (contentLen <= hostLen) return null;
  const sizeRatio = hostLen / contentLen;
  const startRatio = Math.min(1, Math.max(0, (host.start - content.start) / contentLen));
  return { sizeRatio, startRatio };
}

/** How long a position indicator stays fully visible after the last
 *  interaction/resize before fading to fully transparent — the native
 *  overlay-scrollbar "flash then fade" convention. Named so the one place
 *  that needs tuning (a real-app feel check — jsdom can't judge this) is a
 *  single constant. */
const INDICATOR_FADE_DELAY_MS = 800;

/** Write one axis's indicator geometry onto its track/bar DOM, or hide the
 *  track entirely when there's nothing to indicate (`geo === null` — the
 *  "don't leave a zero-length bar visible" rule from the design). `hidden`
 *  (the DOM attribute, not a class) is the single source of visibility here
 *  so there's no separate "is this indicator on" state to drift out of sync
 *  with the geometry that justifies it. Command (void). */
function writeIndicatorGeometry(
  track: HTMLElement,
  bar: HTMLElement,
  sizeProp: "height" | "width",
  startProp: "top" | "left",
  geo: { sizeRatio: number; startRatio: number } | null,
): void {
  track.hidden = geo === null;
  if (!geo) return;
  bar.style[sizeProp] = `${geo.sizeRatio * 100}%`;
  bar.style[startProp] = `${geo.startRatio * 100}%`;
}

/** Open the lightbox for `source` — a local absolute filesystem path (the
 *  explorer's call shape, unchanged) OR a remote/data URL (an editor image
 *  click on `![](https://…)`, added by _workspace/01_architect_design_imgclick.md).
 *  `imageDisplayName`/`imageViewerUrl` own the branch between the two; this
 *  function stays param-name-only "renamed" from the local-only `absPath` it
 *  used to take. Returns a handle whose close() restores the page. */
export function openImageViewer(source: string): ImageViewerHandle {
  const name = imageDisplayName(source);

  // The checkerboard stage doubles as the pan/zoom host (attachPanZoom reuse —
  // mermaid-widget's handler only ever touches host/element geometry + CSS
  // transform, both of which an <img> supports identically to an <svg>).
  const stage = document.createElement("div");
  stage.className = "image-viewer-stage";
  stage.tabIndex = 0; // focusable — keydown panning targets this element only

  const img = document.createElement("img");
  img.className = "image-viewer-img";
  img.alt = name;

  // Read-only position indicators (overlay-scrollbar style): vertical along
  // the stage's right edge for Y-overflow, horizontal along the bottom for
  // X-overflow. `aria-hidden` — purely visual; position information belongs
  // in an AT-facing channel, not a decorative bar (none exists yet, tracked
  // separately, out of this change's scope). `hidden` by default so no
  // zero-length bar is ever in the DOM before the first `refreshPanIndicators`.
  const vTrack = document.createElement("div");
  vTrack.className = "image-viewer-pan-indicator image-viewer-pan-indicator-v";
  vTrack.setAttribute("aria-hidden", "true");
  vTrack.hidden = true;
  const vBar = document.createElement("div");
  vBar.className = "image-viewer-pan-indicator-bar";
  vTrack.append(vBar);

  const hTrack = document.createElement("div");
  hTrack.className = "image-viewer-pan-indicator image-viewer-pan-indicator-h";
  hTrack.setAttribute("aria-hidden", "true");
  hTrack.hidden = true;
  const hBar = document.createElement("div");
  hBar.className = "image-viewer-pan-indicator-bar";
  hTrack.append(hBar);

  stage.append(img, vTrack, hTrack);

  const shell = openViewerShell({ caption: name, paneClass: "image-viewer", content: stage });

  // Flash both tracks to full opacity and (re)start the fade-out timer —
  // called from `refreshPanIndicators` any time either axis has something to
  // show. A single timer (not one per axis) keeps "when do they fade" one
  // rule instead of two independently-drifting ones.
  let fadeTimer = 0;
  const markIndicatorsActive = (): void => {
    vTrack.classList.add("is-active");
    hTrack.classList.add("is-active");
    window.clearTimeout(fadeTimer);
    fadeTimer = window.setTimeout(() => {
      vTrack.classList.remove("is-active");
      hTrack.classList.remove("is-active");
    }, INDICATOR_FADE_DELAY_MS);
  };

  // THE single recompute point for both indicators — every caller below
  // (transform changes, zoom, image load, stage resize) calls exactly this,
  // never writes track/bar geometry itself. That's what guarantees the
  // indicator can't go stale after some ONE gesture nobody remembered to
  // wire up (see attachPanZoom's `onTransform` doc for the same reasoning
  // applied to the transform-write side of this).
  const refreshPanIndicators = (): void => {
    const stageRect = stage.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    const v = panIndicatorFor(
      { start: imgRect.top, end: imgRect.bottom },
      { start: stageRect.top, end: stageRect.bottom },
    );
    const h = panIndicatorFor(
      { start: imgRect.left, end: imgRect.right },
      { start: stageRect.left, end: stageRect.right },
    );
    writeIndicatorGeometry(vTrack, vBar, "height", "top", v);
    writeIndicatorGeometry(hTrack, hBar, "width", "left", h);
    if (v || h) markIndicatorsActive();
  };
  shell.onTeardown(() => window.clearTimeout(fadeTimer));

  // Trigger 1/4: natural size only becomes known once the image has loaded —
  // before that every rect is 0×0 and panIndicatorFor correctly reports null.
  img.onload = () => {
    shell.caption.textContent = loadedCaption(name, img);
    refreshPanIndicators();
  };
  img.onerror = () => {
    // The viewer stays open on a load failure — closing is the user's call,
    // not ours (same "best-effort, never auto-dismiss" stance as ImageWidget's
    // recursive-search fallback).
    shell.caption.textContent = "이미지를 불러올 수 없습니다";
  };
  img.src = imageViewerUrl(source);

  // `force: true` for the same reason the mermaid fullscreen lightbox passes
  // it: `panZoomSetting` is a MERMAID setting (설정 › Mermaid › 팬/줌 — it
  // governs diagrams embedded in a document), and honoring it here made an
  // image viewer whose navigation silently vanished when a user turned that
  // switch off — no drag, and after 2026-07-31 no keyboard or wheel scrolling
  // either. A viewer's only way to reach the rest of a zoomed image is not a
  // Mermaid preference.
  //
  // Trigger 2/4: `onTransform` fires after every write attachPanZoom's
  // `commit()` makes — drag (live + flush), wheel-zoom, dblclick, reset, AND
  // `panBy` (keyboard/wheel-pan) — all funneled through that one path inside
  // attachPanZoom, so this single subscription covers every way the image
  // can move, including drag, without image-viewer.ts needing to know how
  // many gestures attachPanZoom implements.
  const pz = attachPanZoom(stage, img, { force: true, onTransform: refreshPanIndicators });
  shell.onTeardown(() => pz.destroy());

  // Trigger 3/4: zooming changes the image's LAYOUT width (applyImageZoom),
  // which changes both ratios even with translate unchanged.
  const unsubscribeZoom = shell.zoom.bind((factor) => {
    applyImageZoom(img, factor);
    refreshPanIndicators();
  });
  shell.onTeardown(unsubscribeZoom);

  // Trigger 4/4: the STAGE resizing (window resize, sidebar width change)
  // changes the host side of every ratio even when nothing about the image
  // itself changed. jsdom has no `ResizeObserver` (same feature-check
  // fallback shape as hwp-viewer.ts's `observePages`/IntersectionObserver) —
  // there is no eager substitute here since a resize is instantaneous, real
  // (non-jsdom) DOM information; tests instead call `refreshPanIndicators`'s
  // effects indirectly through the other three triggers.
  let stageResizeObserver: ResizeObserver | undefined;
  if (typeof ResizeObserver === "function") {
    stageResizeObserver = new ResizeObserver(() => refreshPanIndicators());
    stageResizeObserver.observe(stage);
  }
  shell.onTeardown(() => stageResizeObserver?.disconnect());

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
