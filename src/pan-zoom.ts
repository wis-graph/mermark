// CSS-transform pan/zoom primitives moved out of mermaid-widget.ts (2026-09-25,
// pure move; design D2/D3, docs/reviews/2026-09-25-architecture-diagnosis.md).
// A root-level leaf (same layer as icons.ts/clipboard.ts) so markdown/** and
// chrome/** can both import it without either importing the other.

import { panZoomSetting } from "./settings/app";

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

/** What `attachPanZoom` hands back: teardown plus a keyboard/wheel-panning
 *  primitive. `panBy` moves the content by (dx, dy) from its CURRENT TARGET
 *  position — not its currently PAINTED position (see `renderedTranslate`
 *  and the comment on `panBy`'s own implementation below for why that
 *  distinction is the whole point: it's what makes animating the move safe).
 *  Clamped (via `clampPanDelta`) so the content's edges never pull inward
 *  past the host's edges — pass ±Infinity on an axis to mean "go all the
 *  way" (Home/End). `opts.animate` (default false) toggles the CSS
 *  transition on the write; callers pick per input kind (image-viewer.ts:
 *  wheel/arrows unanimated for instant feedback, PageUp/PageDown/Home/End
 *  animated so a big jump reads as "went somewhere" instead of "teleported").
 *  Returns the delta actually APPLIED (post-clamp), so a wheel handler can
 *  tell "did this scroll do anything?" and only then swallow the event —
 *  when the returned delta is {0, 0} the content had no room to move and the
 *  caller should let the event bubble (e.g. so the page can scroll instead).
 *  Command with an observation, not a pure query (it mutates the transform),
 *  but reports what it did rather than forcing every caller to re-derive it
 *  via a second rect read. */
export interface PanZoomHandle {
  destroy(): void;
  panBy(dx: number, dy: number, opts?: { animate?: boolean }): { dx: number; dy: number };
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

/** The one axis-agnostic clamp rule for keyboard panning: how far a requested
 *  delta may actually move the content along one axis without letting either
 *  of the content's edges pull inward past the host's matching edge (the
 *  "can't scroll past the end" rule). `maxForward` is how much slack there is
 *  to push the content in the positive direction (content's start edge is
 *  right of the host's start edge); `maxBackward` mirrors that for the
 *  negative direction. Content no bigger than the host has zero slack either
 *  way, so it always clamps to 0. ±Infinity collapses to ±maxForward/maxBackward,
 *  which is exactly Home/End's "go all the way" — one function, no special
 *  casing. Pure query.
 *
 *  Deliberately asymmetric with mouse drag: drag never clamps (the mouse
 *  itself bounds how far a user drags), only `panBy` (keyboard) does. */
export function clampPanDelta(
  delta: number,
  content: { start: number; end: number },
  host: { start: number; end: number },
): number {
  const maxForward = Math.max(0, host.start - content.start);
  const maxBackward = Math.max(0, content.end - host.end);
  const clamped = Math.min(maxForward, Math.max(-maxBackward, delta));
  return clamped === 0 ? 0 : clamped; // never leak -0 (Math.min/max can yield it at a zero-slack edge)
}

/** A 2D `matrix(a, b, c, d, e, f)` has 6 numbers; tx/ty are the last two (e, f). */
const MATRIX_2D_LENGTH = 6;
/** A `matrix3d(...)` is a column-major 4×4 (16 numbers); tx/ty are the 13th/14th
 *  (index 12/13). */
const MATRIX_3D_LENGTH = 16;

/** The translate that is currently PAINTED on screen, read off
 *  `getComputedStyle(el).transform`. While a CSS transition is animating,
 *  the browser reports the INTERPOLATED matrix mid-flight — this is
 *  deliberately NOT the same number as `state`'s target. `panBy` uses this to
 *  recover the content's untransformed base box (`rect − renderedTranslate`)
 *  so it can re-derive where the content is actually HEADED regardless of
 *  how far an in-flight transition has gotten (see `panBy`'s own comment).
 *  Parses `matrix(a,b,c,d,e,f)` (tx=e, ty=f) and `matrix3d(...)` (16 values,
 *  column-major — tx/ty are index 12/13). Anything else — `"none"`, an
 *  unresolved literal like jsdom's `getComputedStyle` returns instead of a
 *  real matrix, garbage — can't be parsed, so this falls back to `fallback`.
 *  Pass the current `state` translate as `fallback`: that's exactly correct
 *  when there's no in-flight transition to correct for (rendered === target
 *  already). Pure query. */
export function renderedTranslate(
  computedTransform: string,
  fallback: { x: number; y: number },
): { x: number; y: number } {
  const trimmed = computedTransform.trim();
  const matrix2d = /^matrix\(([^)]+)\)$/.exec(trimmed);
  if (matrix2d) {
    const parts = matrix2d[1].split(",").map((s) => Number.parseFloat(s));
    if (parts.length === MATRIX_2D_LENGTH && parts.every(Number.isFinite)) {
      return { x: parts[4], y: parts[5] };
    }
  }
  const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(trimmed);
  if (matrix3d) {
    const parts = matrix3d[1].split(",").map((s) => Number.parseFloat(s));
    if (parts.length === MATRIX_3D_LENGTH && parts.every(Number.isFinite)) {
      return { x: parts[12], y: parts[13] };
    }
  }
  return fallback;
}

/** Command: write the current pan/zoom state onto the svg as a CSS transform,
 *  and reflect "is this diagram transformed?" onto the host so the reset button
 *  can show/hide via CSS. The single write path for transform, so the
 *  `is-transformed` toggle stays in sync with every pan/zoom/dblclick/reset.
 *  transform-origin stays 0 0 (set once at attach). `withTransition` animates
 *  the dblclick + reset toggle; pan/wheel pass false for instant feedback. */
function updateTransform(
  host: HTMLElement,
  svg: SVGElement | HTMLImageElement,
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
 *  throws (getBoundingClientRect/transform are tolerated as missing).
 *
 *  `svg` accepts `SVGElement | HTMLImageElement` — the image lightbox
 *  (viewer/image-viewer.ts) reuses this same handler for a plain `<img>`.
 *  The body only ever touches `style.transform`/`getBoundingClientRect`,
 *  which both element kinds support identically, so this is a type
 *  widening only — zero behavior change for the existing mermaid callers.
 *
 *  `opts.force` bypasses the panZoomSetting gate below — the mermaid
 *  fullscreen lightbox (viewer/mermaid-lightbox.ts) always wants pan/zoom
 *  regardless of the inline diagram's setting, since precise inspection is
 *  the entire point of opening fullscreen. Every existing caller omits
 *  `opts`, so `force` defaults to falsy and behavior is unchanged for them.
 *
 *  `opts.onTransform` fires after EVERY write to the transform, from EVERY
 *  path that can change it — drag (both the rAF-coalesced live write and the
 *  mouseup flush), wheel-zoom, dblclick, the reset button, and `panBy`. All
 *  of them are funneled through one local `commit()` so a caller (the image
 *  viewer's position indicator) can observe "the content moved" without
 *  having to know or re-derive which of those six gestures did it — and so
 *  that adding a SEVENTH way to move the content later can't silently forget
 *  to notify. Every existing caller omits `opts.onTransform`, so it's a
 *  no-op for them (mermaid widget, lightbox) — zero behavior change.
 *
 *  Returns a `PanZoomHandle`: `destroy()` plus `panBy(dx, dy, opts?)` for
 *  keyboard panning callers (the image viewer's arrow/Page/Home/End
 *  bindings). Both branches below (off/stub and on/real) return the same
 *  shape so callers never need to branch on whether pan/zoom is active. */
export function attachPanZoom(
  host: HTMLElement,
  svg: SVGElement | HTMLImageElement,
  opts?: { force?: boolean; onTransform?: () => void },
): PanZoomHandle {
  if (panZoomSetting.get() === "off" && !opts?.force)
    return { destroy() {}, panBy: () => ({ dx: 0, dy: 0 }) };

  svg.style.transformOrigin = "0 0";
  const state: PanZoomState = { scale: 1, translateX: 0, translateY: 0 };
  let panning = false;
  let startX = 0;
  let startY = 0;
  let rafId = 0;

  // THE single write path (design invariant, see the `opts.onTransform` doc
  // above): every place in this function that changes the transform calls
  // `commit`, never `updateTransform` directly. That's what guarantees
  // `onTransform` fires for every gesture, not just the ones someone
  // remembered to wire up.
  const commit = (withTransition = false): void => {
    updateTransform(host, svg, state, withTransition);
    opts?.onTransform?.();
  };

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
      commit(); // one write per frame, latest state
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
    commit();
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
    commit();
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
    commit(true);
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
    commit(true);
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
    // Rect-based (not raw arithmetic): reads the ACTUAL boxes so transform-
    // origin/scale/flex-centering are already baked in, matching how
    // `onWheel`'s cursor-zoom reads `host.getBoundingClientRect()` above.
    //
    // v0.9.18 incident (fixed, then re-derived here — history kept because the
    // fix shape changed): panBy used to clamp against `getBoundingClientRect()`
    // directly, i.e. "wherever the content is currently PAINTED". That's wrong
    // whenever a transition is still animating toward a prior panBy's target —
    // the painted rect lags `state`, so the clamp sees slack that's already
    // spoken for, and a fast burst (key repeat, trackpad inertia) keeps adding
    // to `state` past the real boundary (content flies off-screen) while the
    // restarted transition also visibly jitters. The v0.9.18 patch banned
    // animation on panBy entirely to route around this — a source-level
    // premise ("never animate here") standing in for a fix.
    //
    // v0.9.19: the clamp is now computed against the content's TARGET box, not
    // its painted box, so animating panBy is safe regardless of how much of an
    // in-flight transition has completed — the "never animate" premise above
    // is gone; `opts.animate` is a free choice for callers.
    //   base   = renderedRect − renderedTranslate   (the untransformed box —
    //            invariant no matter how far a transition has gotten, since a
    //            transition only ever animates translate, not size)
    //   target = base + state.translate             (where the content is
    //            actually HEADED — `state` is the authoritative accumulator,
    //            updated synchronously by every panBy call regardless of
    //            whether the paint has caught up)
    // Clamping `target` against `hostRect` makes the clamp correct on the
    // first call after a burst, not just once painting has settled.
    //
    // Still no rAF coalescing — but for a DIFFERENT reason than v0.9.18's now-
    // obsolete one (that reason no longer applies: target-based clamping does
    // NOT desync under a deferred write, since `state` — not the paint — is
    // what the clamp reads). The real reason: panBy fires at most once per
    // discrete input event (one keydown, one wheel tick), not a continuous
    // pixel-by-pixel stream like `onMouseMove` — there is no "N writes per
    // frame" problem here to coalesce away, so the added indirection would buy
    // nothing. Revisit only if a real input source starts calling panBy at
    // sub-frame frequency.
    panBy(dx, dy, opts) {
      const animate = opts?.animate ?? false;
      const hostRect = host.getBoundingClientRect();
      const contentRect = svg.getBoundingClientRect();
      const rendered = renderedTranslate(getComputedStyle(svg).transform, {
        x: state.translateX,
        y: state.translateY,
      });
      const baseLeft = contentRect.left - rendered.x;
      const baseTop = contentRect.top - rendered.y;
      const width = contentRect.right - contentRect.left;
      const height = contentRect.bottom - contentRect.top;
      const targetLeft = baseLeft + state.translateX;
      const targetTop = baseTop + state.translateY;
      const clampedDx = clampPanDelta(
        dx,
        { start: targetLeft, end: targetLeft + width },
        { start: hostRect.left, end: hostRect.right },
      );
      const clampedDy = clampPanDelta(
        dy,
        { start: targetTop, end: targetTop + height },
        { start: hostRect.top, end: hostRect.bottom },
      );
      state.translateX += clampedDx;
      state.translateY += clampedDy;
      commit(animate);
      return { dx: clampedDx, dy: clampedDy };
    },
  };
}
