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
  pagePlaceholder,
  pageIndexOf,
  MAX_RENDERED_PAGES,
  MAX_CONCURRENT_RENDERS,
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
    return { pending: new Set(), rendered: new Set(), failed: new Set(), renderTasks: new Map(), textLayers: new Map() };
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

  it("(b) MAX_RENDERED_PAGES eviction: with 21 in-band pages already rendered, the FARTHEST is evicted and the NEAREST survives", () => {
    const state = makeState();
    const pageEls = new Map<number, HTMLElement>();
    const inBand = new Set<number>();
    for (let i = 0; i <= 20; i += 1) {
      const el = pagePlaceholder(i);
      stubGeom(el, farApartTop(i), 100);
      pageEls.set(i, el);
      inBand.add(i);
      state.rendered.add(i); // pretend every one of the 21 already rendered
    }

    reconcile(state, inBand, pageEls, VIEWPORT_CENTER_B, () => {
      throw new Error("no page should be a render candidate — all 21 were already `rendered`");
    });

    // Page 1 is the FARTHEST but the SECOND-oldest; page 0 is the NEAREST but
    // the OLDEST. That split is the whole point of `farApartTop` — under the
    // FIFO `renderOrder` this scheduler used to have, page 0 (oldest) would be
    // the one evicted and page 1 would survive, i.e. exactly inverted from
    // both assertions below. A distance-monotonic layout (page i at i*100
    // with the center at page 0) could not tell the two rules apart at all.
    expect(state.rendered.has(1)).toBe(false); // farthest -> evicted
    expect(state.rendered.has(0)).toBe(true); // nearest (on screen) -> kept despite being oldest
    expect(state.rendered.has(20)).toBe(true); // second-farthest still makes the MAX_RENDERED_PAGES=20 cut
    expect(MAX_RENDERED_PAGES).toBe(20);
  });

  it("(c) a page evicted while still in-band is re-queued by reconcile ALONE — no IntersectionObserver re-fire for that page", () => {
    // Continues directly from (b)'s scenario: 21 pages, page 20 (farthest)
    // just got evicted while remaining in `inBand` the whole time (it never
    // left the 200%-margin band — this is the "on screen but evicted" case
    // the old FIFO scheduler could never recover from without a fresh
    // observer entry for THAT SPECIFIC page).
    const state = makeState();
    const pageEls = new Map<number, HTMLElement>();
    const inBand = new Set<number>();
    for (let i = 0; i <= 20; i += 1) {
      const el = pagePlaceholder(i);
      stubGeom(el, farApartTop(i), 100);
      pageEls.set(i, el);
      inBand.add(i);
      state.rendered.add(i);
    }

    reconcile(state, inBand, pageEls, VIEWPORT_CENTER_B, () => {}); // (b)'s eviction: page 1 dropped
    expect(state.rendered.has(1)).toBe(false);

    // Simulate the band shrinking somewhere ELSE (page 20 scrolls out — a
    // real IntersectionObserver entry, but NOT for page 1, whose own
    // intersection state never changes: it stayed on screen throughout).
    inBand.delete(20);
    const started: number[] = [];
    reconcile(state, inBand, pageEls, VIEWPORT_CENTER_B, (page) => started.push(page));

    // The regression this guards: page 1 comes back into the target (band now
    // has exactly 20 eligible pages, all of which fit under
    // MAX_RENDERED_PAGES) and gets queued for render — purely because
    // `reconcile` re-ran, triggered by page 20's unrelated band-exit, with NO
    // IntersectionObserver event ever touching page 1 itself.
    expect(started).toEqual([1]);
  });
});
