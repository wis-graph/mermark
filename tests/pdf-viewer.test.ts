import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { fitWidthScale } from "../src/extensions/pdf-viewer/fit-width-scale";
import { viewerFor } from "../src/chrome/viewer/registry";
import {
  registerPdfViewer,
  ensureReadableStreamAsyncIterator,
  reconcile,
  renderPdfPage,
  sharpenPdfPage,
  pagePlaceholder,
  pageIndexOf,
  aspectRatioOf,
  documentPageAspect,
  FALLBACK_PAGE_ASPECT,
  MAX_RENDERED_PAGES,
  MAX_CONCURRENT_RENDERS,
  DRAFT_OUTPUT_SCALE,
  draftIsFullQuality,
  type PageRenderState,
  type PdfDocumentProxy,
  type PdfjsModule,
  type PdfPageProxy,
  type PdfViewport,
} from "../src/extensions/pdf-viewer";

describe("fitWidthScale (pure — PDF fit-to-width render scale)", () => {
  // Table test (mermark-frontend §8): a table of (pageWidthPt, containerWidthPx,
  // zoomFactor) -> expected scale, no DOM/layout involved. Parameter renamed
  // from `fontScale` (full-pane rewrite, _workspace/01_architect_design.md
  // §B/§C — the 3rd argument is the viewer SHELL's local zoom
  // (`shell.zoom.get()`), never the editor's fontScale; the old name was a
  // lie post-v0.8.6's fontScale/viewer-zoom decoupling).
  const cases: Array<[number, number, number, number]> = [
    // [pageWidthPt, containerWidthPx, zoomFactor, expected]
    [612, 612, 1, 1], // US Letter width in points, container matches exactly -> scale 1
    [612, 1224, 1, 2], // container twice as wide -> scale 2
    [595.28, 892.92, 1, 1.5], // A4 width, container 1.5x -> scale 1.5
    [612, 612, 1.4, 1.4], // zoom multiplies on top of a fit-width-1 baseline
    [612, 1224, 1.4, 2.8], // both fit-width AND zoom compound
  ];

  it.each(cases)(
    "fitWidthScale(%p, %p, %p) === %p",
    (pageWidthPt, containerWidthPx, zoomFactor, expected) => {
      expect(fitWidthScale(pageWidthPt, containerWidthPx, zoomFactor)).toBeCloseTo(expected, 10);
    },
  );

  it("degenerate: a zero/negative page width falls back to the bare zoom factor (never NaN/Infinity)", () => {
    expect(fitWidthScale(0, 800, 1.2)).toBe(1.2);
    expect(fitWidthScale(-10, 800, 1.2)).toBe(1.2);
  });

  it("degenerate: a zero/negative container width falls back to the bare zoom factor", () => {
    expect(fitWidthScale(612, 0, 1.2)).toBe(1.2);
    expect(fitWidthScale(612, -1, 1.2)).toBe(1.2);
  });

  // Named contract lock (plan Stage 3 RED): a shell zoomFactor of exactly
  // 2.0 doubles the fit-to-width baseline scale — pins the "3rd argument IS
  // the viewer's zoom multiplier" contract independent of the table above,
  // so a future refactor that silently drops the multiply (e.g. reverting to
  // a fixed fontScale=1) turns this red on its own.
  it("zoomFactor 2.0 doubles the fit-to-width scale", () => {
    expect(fitWidthScale(612, 612, 2.0)).toBeCloseTo(2.0, 10);
    expect(fitWidthScale(595.28, 892.92, 2.0)).toBeCloseTo(3.0, 10); // 1.5 fit-width x2 zoom
  });
});

describe("PDF viewer registration", () => {
  it("registerPdfViewer() claims \"pdf\" — viewerFor(\"pdf\") resolves to id \"ext.pdf\"", () => {
    registerPdfViewer();
    const viewer = viewerFor("pdf");
    expect(viewer).not.toBeNull();
    expect(viewer?.id).toBe("ext.pdf");
    expect(viewer?.extensions).toContain("pdf");
  });

  it("a second registerPdfViewer() call throws (registerViewer's own duplicate-id guard)", () => {
    // registerPdfViewer() already ran once in the previous test (module-level
    // registry state persists across tests in the same file, same pattern
    // hwp-viewer/excel-viewer registration tests already rely on).
    expect(() => registerPdfViewer()).toThrow(/already registered/);
  });
});

describe("ensureReadableStreamAsyncIterator (WKWebView ReadableStream async-iter polyfill)", () => {
  // The production Tauri WKWebView lacks `ReadableStream.prototype[Symbol.asyncIterator]`,
  // which pdf.js's getTextContent needs (`for await (const value of readableStream)`).
  // Node/jsdom DO ship it, so we delete it to simulate the WKWebView gap, then
  // assert the polyfill restores working `for await` iteration. This is the
  // regression guard for the 0.8.4 blank-PDF fix — removing the polyfill turns
  // this red. Save/restore so no other test sees a mutated global prototype.
  const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
  const original = proto[Symbol.asyncIterator];

  function streamOf(values: number[]): ReadableStream<number> {
    return new ReadableStream<number>({
      start(controller) {
        for (const v of values) controller.enqueue(v);
        controller.close();
      },
    });
  }

  it("no-op when the engine already implements async iteration (native path preserved)", () => {
    // original is defined here (Node), so the function must NOT overwrite it.
    ensureReadableStreamAsyncIterator();
    expect(proto[Symbol.asyncIterator]).toBe(original);
  });

  it("installs a working async iterator when the engine lacks one (the WKWebView case)", async () => {
    delete proto[Symbol.asyncIterator]; // simulate WKWebView
    expect(Symbol.asyncIterator in proto).toBe(false);
    try {
      ensureReadableStreamAsyncIterator();
      expect(Symbol.asyncIterator in proto).toBe(true);

      const collected: number[] = [];
      for await (const value of streamOf([1, 2, 3])) collected.push(value);
      expect(collected).toEqual([1, 2, 3]);
    } finally {
      proto[Symbol.asyncIterator] = original; // restore native
    }
  });

  it("idempotent: a second call after installing does not replace the shim", () => {
    delete proto[Symbol.asyncIterator];
    try {
      ensureReadableStreamAsyncIterator();
      const shim = proto[Symbol.asyncIterator];
      ensureReadableStreamAsyncIterator();
      expect(proto[Symbol.asyncIterator]).toBe(shim);
    } finally {
      proto[Symbol.asyncIterator] = original;
    }
  });
});

// 재호출 4차 (팀리드 지시, 2026-07-27): pdf pages used to render as a floating
// A4 sheet — box-shadow + a 0.9-fraction reading margin — inside the column.
// The team lead asked for the same flat, borderless, edge-to-edge look the
// html/docx viewers already have, while keeping the per-page gap (pdf stays
// genuinely multi-page, unlike docx which went page-less flat the same day).
// These lock the new contract at the source level (same technique
// docx-viewer.test.ts's "flat panel-filling layout" describe block uses).
describe("pdf viewer: flat page-column layout (no page-frame shadow, full-width pages)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(ROOT, "src", "extensions", "pdf-viewer", "index.ts"), "utf8");

  it("no drop-shadow rule is injected for .pdf-viewer-page (the page-frame look is gone)", () => {
    expect(src).not.toMatch(/box-shadow:\s*0[^;]*;/);
    expect(src).toMatch(/\.pdf-viewer-page\s*\{[^}]*box-shadow:\s*none/);
  });

  it("PDF_PAGE_WIDTH_FRACTION is 1 (fills the column, no reading margin either side)", () => {
    expect(src).toMatch(/const PDF_PAGE_WIDTH_FRACTION = 1;/);
  });

  // 사용자 리포트 2026-08-17 ("스크롤이 아주 지멋대로", 122쪽 A4 자습서 PDF).
  // `.pdf-viewer-pages` is a COLUMN flex container, so the default
  // `flex-shrink: 1` on a page applies to its HEIGHT. The container's height
  // is definite while the column overflows it enormously, so pages get
  // squashed to `min-height: auto` — a minimum that DIFFERS BY RENDER STATE
  // (a rendered page holds its canvas; an empty placeholder collapses toward
  // zero). Total column height then lurched every time a page rendered or was
  // evicted, dragging the scroll position with it. styles.css's
  // `.hwp-viewer-page` — the page-render viewer this file's own comments call
  // the standard precedent — has carried `flex: none` all along; the PDF
  // viewer simply never copied it. Source-level lock (same technique as the
  // two assertions above) because no jsdom test can observe flex layout.
  it(".pdf-viewer-page declares flex: none (a page in a scrolling column must never shrink)", () => {
    expect(src).toMatch(/\.pdf-viewer-page\s*\{[^}]*flex:\s*none/);
  });
});

// 재호출 (team-lead spec, 2026-08-17, 실측): a real 1134-page/174MB book
// (Gödel, Escher, Bach) measures 1840x2650 CSS px per page — aspect ratio
// 0.6943 — against this file's OLD hardcoded A4 guess of 210/297 = 0.7071.
// Every canvas swap grew that page ~1.85% taller and pushed the rest of the
// column down mid-scroll ("페이지가 급변해" 사용자 리포트). (d) below pins
// `documentPageAspect` reading the REAL page-1 viewport instead of guessing
// A4; it fails against the pre-change file because `documentPageAspect`,
// `aspectRatioOf`, and `FALLBACK_PAGE_ASPECT` did not exist as exports yet
// (a TS compile error, not just a wrong runtime value) and `pagePlaceholder`
// took no `aspect` argument at all — every placeholder was hardcoded to
// `"210 / 297"` regardless of the document (`git show
// b17262c:src/extensions/pdf-viewer/index.ts` — the commit this task
// started from — confirms both: no such exports, `pagePlaceholder(n:
// number)` single-arg, `el.style.aspectRatio = "210 / 297"` unconditional).
describe("PDF viewer: placeholder aspect ratio comes from the document itself, not an A4 guess", () => {
  function fakeSinglePageDoc(width: number, height: number): PdfDocumentProxy {
    return {
      numPages: 1,
      getPage: async (): Promise<PdfPageProxy> => ({
        getViewport: (): PdfViewport => ({ width, height }),
        getTextContent: async () => ({}),
        render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      }),
    };
  }

  it("(d) documentPageAspect reads page 1's real viewport (1840x2650 book), and pagePlaceholder uses it verbatim", async () => {
    const doc = fakeSinglePageDoc(1840, 2650);

    const aspect = await documentPageAspect(doc);
    expect(aspect).toBe(aspectRatioOf({ width: 1840, height: 2650 }));
    expect(aspect).toBe("1840 / 2650");
    expect(aspect).not.toBe(FALLBACK_PAGE_ASPECT); // NOT the A4 guess

    const ph = pagePlaceholder(1, aspect);
    expect(ph.style.aspectRatio).toBe("1840 / 2650");
  });

  it("falls back to FALLBACK_PAGE_ASPECT (A4) when page 1 itself can't be read", async () => {
    const brokenDoc: PdfDocumentProxy = {
      numPages: 1,
      getPage: async (): Promise<PdfPageProxy> => {
        throw new Error("boom");
      },
    };
    expect(await documentPageAspect(brokenDoc)).toBe(FALLBACK_PAGE_ASPECT);
    expect(FALLBACK_PAGE_ASPECT).toBe("210 / 297");
  });
});

// reconcile scheduler (team-lead spec, 2026-08-17): pending Set only ever
// blocked a SAME-page double-request, never bounded how many DIFFERENT pages
// rendered at once, and eviction was renderOrder FIFO — oldest push-order,
// not "farthest from the viewport". Both let a band of 5-10 in-view pages
// fire every render at once (bursty loads) and let a shrunk/zoomed panel
// evict a page still on screen with nothing left to re-request it (its
// element never stops intersecting, so IntersectionObserver never re-fires
// for it). These three tests pin the fix at the unit level, calling
// `reconcile`/`renderPdfPage` directly with a fully controllable fake
// pdfDoc/render-task so render "resolution" timing is explicit rather than
// racing real pdf.js/worker/fetch machinery (out of scope for a unit test).
// Verified failing against the pre-change code: a scratch copy of the old
// renderPdfPage/enforceRenderCap (git show HEAD:...), exercised the same
// way, showed (a) 3 concurrent render() calls with zero cap and (b) FIFO
// evicting the page nearest the viewport center while a farther page
// survived — the exact opposite of what's asserted below.
describe("PDF viewer: reconcile-based render scheduler (distance rank + concurrency cap)", () => {
  /** Give a page element a fake VIEWPORT-coordinate box, because that is what
   *  `distanceFromViewportCenter` actually reads (`getBoundingClientRect()`,
   *  not `offsetTop`/`offsetHeight` — see its comment on why `offsetParent`
   *  made those two the wrong coordinate space). This must keep matching the
   *  geometry accessor the scheduler uses: jsdom runs no layout, so an
   *  un-stubbed `getBoundingClientRect()` returns an all-zero rect, which
   *  would make EVERY page tie at distance 0 and silently degrade the
   *  distance ranking these tests exist to pin into plain insertion order —
   *  a green suite asserting nothing. (Exactly that happened once: the source
   *  moved to rects while this helper still stubbed `offsetTop`.) */
  function stubGeom(el: HTMLElement, top: number, height: number): void {
    Object.defineProperty(el, "getBoundingClientRect", {
      value: () => ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }),
      configurable: true,
    });
  }

  function makeState(): PageRenderState {
    return {
      pending: new Set(),
      rendered: new Set(),
      failed: new Set(),
      renderTasks: new Map(),
      textLayerPending: new Set(),
      textLayerRendered: new Set(),
      textLayerFailed: new Set(),
      textLayers: new Map(),
      fullQuality: new Set(),
      sharpenPending: new Set(),
      sharpenFailed: new Set(),
      sharpenTasks: new Map(),
    };
  }

  /** Temporarily stub `window.devicePixelRatio` for one test, restoring the
   *  original value afterward regardless of pass/fail — the sharpen tests
   *  (f)-(i) below all need to simulate either a Retina (2) or non-Retina
   *  (1) runtime, and jsdom's own default must not leak between tests. */
  async function withDpr<T>(dpr: number, fn: () => T | Promise<T>): Promise<T> {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
    try {
      return await fn(); // awaited so the stub stays in place through async test bodies, not just until `fn()` returns a pending Promise
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { value: original, configurable: true });
    }
  }

  /** A pdfDoc/pdfjs pair whose `render()` task resolves ONLY when the test
   *  calls `resolvePage`/`rejectPage` — the "가짜 pdfDoc/렌더태스크로 해소
   *  시점을 제어" the design calls for, so a test can observe exactly how
   *  many renders are mid-flight before any of them finish. */
  function makeControllablePdf(): {
    pdfDoc: PdfDocumentProxy;
    pdfjs: PdfjsModule;
    renderCalls: number[];
    resolvePage: (page: number) => void;
    rejectPage: (page: number, err: unknown) => void;
  } {
    const renderCalls: number[] = [];
    const resolvers = new Map<number, { resolve: () => void; reject: (e: unknown) => void }>();
    const pdfDoc: PdfDocumentProxy = {
      numPages: 0,
      getPage: async (n: number): Promise<PdfPageProxy> => ({
        getViewport: ({ scale }: { scale: number }): PdfViewport => ({ width: 100 * scale, height: 140 * scale }),
        getTextContent: async () => ({}),
        render: () => {
          renderCalls.push(n);
          const promise = new Promise<void>((resolve, reject) => resolvers.set(n, { resolve, reject }));
          return { promise, cancel: () => {} };
        },
      }),
    };
    const pdfjs = {
      getDocument: () => {
        throw new Error("not used by these tests");
      },
      PDFWorker: class {
        destroy() {}
      },
      TextLayer: class {
        constructor(_params: unknown) {}
        render() {
          return Promise.resolve();
        }
        cancel() {}
      },
    } as unknown as PdfjsModule;
    return {
      pdfDoc,
      pdfjs,
      renderCalls,
      resolvePage: (page) => resolvers.get(page)?.resolve(),
      rejectPage: (page, err) => resolvers.get(page)?.reject(err),
    };
  }

  async function flush(times = 5): Promise<void> {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
  }

  // 5 pages spaced 100px apart (rect tops 0,100,200,300,400 — height 100),
  // viewportCenter=220 gives every page a DISTINCT distance (no ties to
  // reason about): page3 closest (30), then 2 (70), 4 (130), 1 (170), 5 (230).
  function fivePageEls(): Map<number, HTMLElement> {
    const pageEls = new Map<number, HTMLElement>();
    for (let n = 1; n <= 5; n += 1) {
      const el = pagePlaceholder(n);
      stubGeom(el, (n - 1) * 100, 100);
      pageEls.set(n, el);
    }
    return pageEls;
  }
  const VIEWPORT_CENTER = 220;
  const pagesEl = document.createElement("div"); // clientWidth=0 in jsdom -> pageTargetWidth's 600px fallback

  it("(a) concurrency: with 5 pages in band, at most MAX_CONCURRENT_RENDERS render is in flight at once", async () => {
    const state = makeState();
    const pageEls = fivePageEls();
    const inBand = new Set([1, 2, 3, 4, 5]);
    const { pdfDoc, pdfjs, renderCalls, resolvePage } = makeControllablePdf();

    function runReconcile(): void {
      reconcile(state, inBand, pageEls, VIEWPORT_CENTER, (page, el) =>
        renderPdfPage(page, el, pdfDoc, pdfjs, state, pagesEl, 1, runReconcile),
      );
    }

    runReconcile();
    expect(state.pending.size).toBeLessThanOrEqual(MAX_CONCURRENT_RENDERS);
    await flush();
    // Only the nearest page (3) started — the other 4 in-band pages are
    // real candidates too, but the concurrency-1 gate holds them back.
    expect(renderCalls).toEqual([3]);
    expect(state.pending.size).toBe(1);

    resolvePage(3);
    await flush();
    // Page 3 settled -> reconcile ran again via onSettled -> the NEXT
    // nearest (page 2) got the freed slot. Still never more than 1 in
    // flight at any point observed.
    expect(renderCalls).toEqual([3, 2]);
    expect(state.pending.size).toBe(1);
  });

  /** Page tops for (b)/(c), deliberately NOT monotonic in the page number:
   *  page 0 sits at the viewport center (nearest) while page 1 — the SECOND
   *  page to be inserted/rendered — is flung far below every other page
   *  (farthest). Distance rank and insertion rank therefore disagree, which
   *  is the only way these tests can distinguish distance-based eviction from
   *  the FIFO `renderOrder` eviction this scheduler replaced: with the
   *  obvious `top = i * 100` layout, "farthest" and "oldest" are the same
   *  page and a FIFO implementation passes unchanged. */
  const VIEWPORT_CENTER_B = 50;
  function farApartTop(page: number): number {
    return page === 1 ? 5000 : page * 100;
  }

  it("(b) MAX_RENDERED_PAGES eviction: with 11 in-band pages already rendered, the FARTHEST is evicted and the NEAREST survives", () => {
    const state = makeState();
    const pageEls = new Map<number, HTMLElement>();
    const inBand = new Set<number>();
    for (let i = 0; i <= 10; i += 1) {
      const el = pagePlaceholder(i);
      stubGeom(el, farApartTop(i), 100);
      pageEls.set(i, el);
      inBand.add(i);
      state.rendered.add(i); // pretend every one of the 11 already rendered
    }

    reconcile(state, inBand, pageEls, VIEWPORT_CENTER_B, () => {
      throw new Error("no page should be a render candidate — all 11 were already `rendered`");
    });

    // Page 1 is the FARTHEST but the SECOND-oldest; page 0 is the NEAREST but
    // the OLDEST. That split is the whole point of `farApartTop` — under the
    // FIFO `renderOrder` this scheduler used to have, page 0 (oldest) would be
    // the one evicted and page 1 would survive, i.e. exactly inverted from
    // both assertions below. A distance-monotonic layout (page i at i*100
    // with the center at page 0) could not tell the two rules apart at all.
    // (재호출 2026-08-17: cap dropped 20 -> 10, MAX_RENDERED_PAGES's own
    // comment for why; the scenario shrank from 21 to 11 pages to keep the
    // "exactly 1 over cap, evict exactly the farthest" shape, same
    // discriminating power.)
    expect(state.rendered.has(1)).toBe(false); // farthest -> evicted
    expect(state.rendered.has(0)).toBe(true); // nearest (on screen) -> kept despite being oldest
    expect(state.rendered.has(10)).toBe(true); // second-farthest still makes the MAX_RENDERED_PAGES=10 cut
    expect(MAX_RENDERED_PAGES).toBe(10);
  });

  it("(c) a page evicted while still in-band is re-queued by reconcile ALONE — no IntersectionObserver re-fire for that page", () => {
    // Continues directly from (b)'s scenario: 11 pages, page 1 (farthest)
    // just got evicted while remaining in `inBand` the whole time (it never
    // left the 200%-margin band — this is the "on screen but evicted" case
    // the old FIFO scheduler could never recover from without a fresh
    // observer entry for THAT SPECIFIC page).
    const state = makeState();
    const pageEls = new Map<number, HTMLElement>();
    const inBand = new Set<number>();
    for (let i = 0; i <= 10; i += 1) {
      const el = pagePlaceholder(i);
      stubGeom(el, farApartTop(i), 100);
      pageEls.set(i, el);
      inBand.add(i);
      state.rendered.add(i);
    }

    reconcile(state, inBand, pageEls, VIEWPORT_CENTER_B, () => {}); // (b)'s eviction: page 1 dropped
    expect(state.rendered.has(1)).toBe(false);

    // Simulate the band shrinking somewhere ELSE (page 10 — the
    // second-farthest, still inside the MAX_RENDERED_PAGES=10 cut — scrolls
    // out: a real IntersectionObserver entry, but NOT for page 1, whose own
    // intersection state never changes: it stayed on screen throughout).
    inBand.delete(10);
    const started: number[] = [];
    reconcile(state, inBand, pageEls, VIEWPORT_CENTER_B, (page) => started.push(page));

    // The regression this guards: page 1 comes back into the target (band now
    // has exactly 10 eligible pages, all of which fit under
    // MAX_RENDERED_PAGES) and gets queued for render — purely because
    // `reconcile` re-ran, triggered by page 10's unrelated band-exit, with NO
    // IntersectionObserver event ever touching page 1 itself.
    expect(started).toEqual([1]);
  });

  // 재호출 (team-lead spec, 2026-08-17): text-layer construction split out of
  // renderPdfPage into its own step (renderTextLayer), scheduled by
  // reconcile's optional 6th arg ONLY for pages close to the viewport —
  // never for a page that merely sits in the wider 200%-margin canvas
  // prefetch band. This pins that split at the scheduler level, the same
  // way (a)-(c) pin the canvas half, without touching pdf.js/Worker/fetch.
  it("(e) a page merely in the prefetch band gets a canvas but NOT a text layer; a page near the viewport gets both", () => {
    const state = makeState();
    const pageEls = new Map<number, HTMLElement>();

    // near: rect center sits exactly AT the viewport center (distance 0) ->
    // within TEXT_LAYER_DISTANCE_FRACTION of ANY plausible panelHeight.
    const near = pagePlaceholder(1);
    stubGeom(near, 0, 100);
    pageEls.set(1, near);

    // far: rect center sits 5000px from the viewport center — still "in
    // band" (canvas prefetch's 200%-margin observer would report this as
    // intersecting on a tall document), but far outside ANY sane fraction
    // of a 100px panelHeight, so it must be excluded regardless of the
    // exact TEXT_LAYER_DISTANCE_FRACTION value.
    const far = pagePlaceholder(2);
    stubGeom(far, 5000, 100);
    pageEls.set(2, far);

    const inBand = new Set([1, 2]);
    state.rendered.add(1); // both canvases already rendered — text-layer
    state.rendered.add(2); // eligibility only ever looks at rendered pages

    const startedText: number[] = [];
    reconcile(
      state,
      inBand,
      pageEls,
      50, // viewport center — matches `near`'s rect center exactly
      () => {
        throw new Error("no canvas candidate expected — both pages already rendered");
      },
      { panelHeight: 100, startTextLayer: (page) => startedText.push(page) },
    );

    expect(startedText).toEqual([1]);
  });

  // 재호출 (team-lead spec, 2026-08-17): progressive draft-then-sharp raster.
  // Fails against the pre-change file for a structural reason first — none
  // of `sharpenPdfPage`/`DRAFT_OUTPUT_SCALE`/`draftIsFullQuality` existed as
  // exports yet (a TS/import-resolution failure, not just a wrong runtime
  // value — confirmed against this task's starting commit `f74af01`, which
  // has no such exports and unconditionally rasters every canvas at
  // `window.devicePixelRatio`), and at the runtime-behavior level: every
  // canvas rendered at full `devicePixelRatio` resolution on its FIRST
  // paint, `fullQuality`/`sharpenPending`/`sharpenFailed` didn't exist on
  // `PageRenderState` at all, and `reconcile` had no sharpen step to gate.
  it("(f) the FIRST canvas for a page renders at DRAFT_OUTPUT_SCALE, never at devicePixelRatio", async () => {
    await withDpr(2, async () => {
      const state = makeState();
      const el = pagePlaceholder(1);
      const { pdfDoc, pdfjs, resolvePage } = makeControllablePdf();

      renderPdfPage(1, el, pdfDoc, pdfjs, state, pagesEl, 1, () => {});
      await flush(); // let the async chain reach pdfPage.render() before resolving it
      resolvePage(1);
      await flush();

      const canvas = el.querySelector("canvas") as HTMLCanvasElement;
      expect(canvas).toBeTruthy();
      // Fake pdf: unscaled width 100pt, pageTargetWidth falls back to 600px
      // (jsdom clientWidth 0) -> fit-width scale 6 -> viewport.width 600 CSS
      // px. Draft backing store must be 600 * DRAFT_OUTPUT_SCALE(1) = 600,
      // NOT 600 * devicePixelRatio(2) = 1200 (the pre-change formula).
      expect(DRAFT_OUTPUT_SCALE).toBe(1);
      expect(canvas.width).toBe(600);
      expect(canvas.height).toBe(840); // 140 * scale(6) * DRAFT_OUTPUT_SCALE(1)
      // dpr=2 -> the draft is NOT yet full quality; a sharpen pass is owed.
      expect(state.fullQuality.has(1)).toBe(false);
    });
  });

  it("(g) sharpen never starts while a draft render is pending; once drafts are idle, the nearest page sharpens first", () => {
    const state = makeState();
    const pageEls = fivePageEls(); // distances from center 220: 3(30) < 2(70) < 4(130) < 1(170) < 5(230)
    state.pending.add(5); // a draft is in flight (page identity irrelevant to the sharpen gate)
    state.rendered.add(2);
    state.rendered.add(3); // both already have a draft canvas; neither is fullQuality yet
    const inBand = new Set([2, 3]);

    const blockedByDraft: number[] = [];
    reconcile(
      state,
      inBand,
      pageEls,
      VIEWPORT_CENTER,
      () => {
        throw new Error("no draft candidate expected — 2 and 3 are already `rendered`");
      },
      undefined,
      { startSharpen: (page) => blockedByDraft.push(page) },
    );
    expect(blockedByDraft).toEqual([]); // draft (page 5) still pending -> sharpen withheld entirely

    state.pending.delete(5); // the draft settles
    const startedSharpen: number[] = [];
    reconcile(
      state,
      inBand,
      pageEls,
      VIEWPORT_CENTER,
      () => {
        throw new Error("no draft candidate expected");
      },
      undefined,
      { startSharpen: (page) => startedSharpen.push(page) },
    );
    // Both 2 and 3 need sharpening, but MAX_CONCURRENT_SHARPEN_RENDERS is 1
    // and page 3 (distance 30) is nearer the viewport center than page 2
    // (distance 70) — same nearest-first ranking canvas/text-layer
    // scheduling already use.
    expect(startedSharpen).toEqual([3]);
  });

  it("(h) sharpening swaps the canvas wrap in place and preserves the sibling text layer untouched", async () => {
    await withDpr(2, async () => {
      const state = makeState();
      const el = pagePlaceholder(1);
      const draftWrap = document.createElement("div");
      draftWrap.className = "pdf-viewer-canvas-wrap";
      draftWrap.appendChild(document.createElement("canvas"));
      const textLayerEl = document.createElement("div");
      textLayerEl.className = "textLayer";
      el.replaceChildren(draftWrap, textLayerEl); // mirrors renderPdfPage + renderTextLayer's real DOM shape
      state.rendered.add(1); // sharpen only ever targets an already-drafted page

      const { pdfDoc, resolvePage } = makeControllablePdf();
      sharpenPdfPage(1, el, pdfDoc, state, pagesEl, 1, () => {});
      await flush(); // let the async chain reach pdfPage.render() before resolving it
      resolvePage(1);
      await flush();

      expect(el.querySelector(".textLayer")).toBe(textLayerEl); // same node — never touched by the swap
      expect(el.querySelector(".pdf-viewer-canvas-wrap")).not.toBe(draftWrap); // the draft wrap WAS replaced
      expect(el.children.length).toBe(2); // still exactly [canvasWrap, textLayer] — nothing extra, nothing lost
      expect(state.fullQuality.has(1)).toBe(true);
      expect(state.sharpenPending.has(1)).toBe(false);
    });
  });

  it("(i) devicePixelRatio === 1: sharpening never starts — the draft alone counts as full quality", async () => {
    await withDpr(1, async () => {
      expect(draftIsFullQuality()).toBe(true);

      const state = makeState();
      const el = pagePlaceholder(1);
      const { pdfDoc, pdfjs, resolvePage } = makeControllablePdf();
      renderPdfPage(1, el, pdfDoc, pdfjs, state, pagesEl, 1, () => {});
      await flush(); // let the async chain reach pdfPage.render() before resolving it
      resolvePage(1);
      await flush();
      expect(state.fullQuality.has(1)).toBe(true); // draft settle already marked it full quality

      const startedSharpen: number[] = [];
      reconcile(
        state,
        new Set([1]),
        new Map([[1, el]]),
        50,
        () => {
          throw new Error("no draft candidate expected — page 1 is already `rendered`");
        },
        undefined,
        { startSharpen: (page) => startedSharpen.push(page) },
      );
      expect(startedSharpen).toEqual([]); // fullQuality already true -> never a sharpenCandidates hit
    });
  });
});
