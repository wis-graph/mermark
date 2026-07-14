// Global test setup. jsdom does not implement window.matchMedia, which
// systemTheme() (src/theme.ts) calls at module-init of settings/app.ts. Now that
// the settings registry is imported transitively (e.g. mermaid-widget reads
// panZoomSetting), ANY test that mounts the editor or a widget pulls app.ts in,
// so matchMedia must exist environment-wide. Default matches:false → dark, the
// app's default. Individual tests can still vi.stubGlobal a different value.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

// jsdom implements Element.prototype.getClientRects()/getBoundingClientRect()
// (both return zero-sized results — jsdom does no layout), but NOT
// Range.prototype.getClientRects()/getBoundingClientRect() — those are simply
// absent, not zero-returning. CodeMirror 6's clientRectsFor (view/dist) calls
// `textRange(dom, from, to).getClientRects()` on every text-size measurement
// pass (measureTextSize, runAnimationFrameCallbacks), so any test that mounts
// the real editor can hit `range.getClientRects is not a function` — and
// because that measurement runs inside a requestAnimationFrame callback, the
// TypeError throws asynchronously, after the test that triggered it has
// already finished, so it surfaces as an unhandled rejection that fails an
// unrelated later test (or the whole `vitest run` process) instead of the
// test that caused it. This is not "faking a passing measurement" — jsdom
// genuinely cannot lay out text, so no real width/height exists to report;
// mirroring jsdom's OWN empty-array/zero-rect convention for Element just
// makes that same "measurement is impossible here" fact honest for Range too.
// CM6 already defensively checks rects.length before trusting a result (e.g.
// measureTextSize's `if (rects.length != 1) return undefined`), so an empty
// list makes it fall back to its non-measured defaults instead of throwing.
if (typeof Range !== "undefined") {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = function (): DOMRectList {
      return [] as unknown as DOMRectList;
    };
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = function (): DOMRect {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} } as DOMRect;
    };
  }
}
