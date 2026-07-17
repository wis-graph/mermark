// The PDF viewer — an EXTENSION (not built-in, unlike HWP): it needs zero new
// Tauri commands. `readLocalFileBytes` (../../api) already fetches a local
// file's raw bytes through the existing asset-protocol path (R11's contract:
// "extension = frontend only, zero new IPC" — same reasoning excel-viewer and
// html-viewer already follow). Registers through the same `registerViewer`
// every other viewer uses, so opening a non-markdown file has exactly one
// dispatch path regardless of built-in vs. extension.
//
// COLD LOAD (CLAUDE.md's constraint, same rule excel-viewer's ~1MB `xlsx`
// follows): `pdfjs-dist` is dynamic-imported ONLY inside open()'s handler —
// never at module load / registerPdfViewer() time — so activateExtensions()
// (main.ts boot) never pulls it into the initial bundle.
//
// SECURITY: getDocument() is handed a same-origin "/pdfjs/..." URL for every
// asset path (cMapUrl/standardFontDataUrl/iccUrl/wasmUrl) and the worker is
// constructed from a same-origin "/pdfjs/build/pdf.worker.mjs" script — this
// app's CSP `script-src 'self'` / `connect-src 'self'` never sees a
// cross-origin request for any of it (vite.config.ts's `pdfjsAssetsPlugin`
// serves these in dev and copies them into `dist/pdfjs` at build time — no
// CDN, no blob:).
import {
  registerViewer,
  openViewerShell,
  readLocalFileBytes,
  fontScale,
  type Viewer,
  type ViewerHandle,
} from "../../api";
import { fitWidthScale } from "./fit-width-scale";

const STYLE_ID = "ext-pdf-viewer-style";

/** Inject this extension's own `<style>` once (idempotent) — extensions can't
 *  touch styles.css (design §6, fence spirit; excel/html viewer precedent).
 *  Command (void). */
function ensureStyleInjected(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Size envelope: viewport units only (no px width/height/max-* literal —
  // tests/viewer-size-envelope.test.ts sweeps this file's injected CSS the
  // same way it sweeps excel/html-viewer's). A document reader wants to be
  // WIDE like html-viewer/hwp-viewer, not content-hugging like excel-viewer.
  style.textContent = `
.pdf-viewer { width: 92vw; height: 88vh; max-height: 88vh; }
.pdf-viewer-pages {
  flex: 1; min-height: 0; overflow: auto;
  display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 8px 0;
}
.pdf-viewer-page {
  position: relative; background: #fff; box-shadow: 0 1px 4px color-mix(in srgb, #000 25%, transparent);
}
.pdf-viewer-page .pdf-viewer-canvas-wrap { position: relative; display: block; }
.pdf-viewer-page canvas { display: block; }
.pdf-viewer-page-error {
  padding: 12px; color: var(--muted); font-size: calc(12.5em / 13);
  background: var(--surface); width: 100%; box-sizing: border-box;
  white-space: normal; overflow-wrap: anywhere;
}
.pdf-viewer-status { padding: 12px; color: var(--muted); font-size: 1em; }
`;
  document.head.appendChild(style);
}

/** A minimal shape of the pdfjs-dist module surface this file actually calls
 *  — kept local rather than depending on `pdfjs-dist`'s own types at the call
 *  sites below, so the dynamic `import("pdfjs-dist")` return value has a name
 *  worth reading in this file's signatures. */
interface PdfjsModule {
  getDocument(params: Record<string, unknown>): PdfLoadingTask;
  PDFWorker: new (params: { port: Worker }) => { destroy(): void };
  TextLayer: new (params: {
    textContentSource: unknown;
    container: HTMLElement;
    viewport: PdfViewport;
  }) => { render(): Promise<unknown>; cancel(): void };
}
interface PdfViewport {
  width: number;
  height: number;
}
interface PdfPageProxy {
  getViewport(params: { scale: number }): PdfViewport;
  getTextContent(): Promise<unknown>;
  render(params: {
    canvas: HTMLCanvasElement;
    viewport: PdfViewport;
    transform?: number[];
  }): { promise: Promise<void>; cancel(): void };
}
interface PdfDocumentProxy {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxy>;
}
/** `getDocument()`'s return value — `.destroy()` lives HERE, not on the
 *  resolved `PdfDocumentProxy` (a real bug this file shipped with initially:
 *  `pdfDoc.destroy()` threw "not a function" at close-time, which — because
 *  it ran inside a `shell.onTeardown` callback with nothing catching it —
 *  broke `shell.close()`'s own cleanup mid-flight and left the Esc-pressed
 *  backdrop on screen; caught by viewer-golden's G13 `backdropCountAfterEsc`
 *  assertion actually turning red on the FIRST real run against this code,
 *  not assumed from reading the types). */
interface PdfLoadingTask {
  promise: Promise<PdfDocumentProxy>;
  destroy(): Promise<void>;
}

/** The fraction of the pages column ONE page occupies — a reading column
 *  narrower than the full panel, leaving a modest margin on both sides. Kept in
 *  lockstep with hwp-viewer.ts's `HWP_PAGE_WIDTH_FRACTION` so the two document
 *  viewers render pages at the SAME width (사용자 지정 2026-07-18: "hwp 는 90%",
 *  and PDF was rendering at the FULL column width — "과도하게 크게"). Change this
 *  and `HWP_PAGE_WIDTH_FRACTION` together — they are one design decision. */
const PDF_PAGE_WIDTH_FRACTION = 0.9;

/** The width (px) one page is fit to — `PDF_PAGE_WIDTH_FRACTION` of the page
 *  column's actual rendered width. Reading `clientWidth` forces a synchronous
 *  layout, fine here since it's only read on open, resize, and zoom change,
 *  never per-frame. `HWP_PAGE_FALLBACK_WIDTH`-style jsdom fallback
 *  (hwp-viewer.ts precedent): jsdom never runs real layout, so `clientWidth` is
 *  always 0 there. Pure query. */
function pageTargetWidth(pagesEl: HTMLElement): number {
  return (pagesEl.clientWidth || 600) * PDF_PAGE_WIDTH_FRACTION;
}

/** The page index a placeholder/rendered element belongs to — mirrors
 *  hwp-viewer.ts's `pageIndexOf` (single place `data-page` is read back so
 *  the observer callback and the render swap agree on the parse). Pure
 *  query. 1-indexed (pdf.js's own page numbering) so it can be handed
 *  straight to `pdfDoc.getPage`. */
function pageIndexOf(el: HTMLElement): number {
  return Number(el.dataset.page ?? "-1");
}

/** Build one page's placeholder element — an empty column slot, A4-ish
 *  aspect ratio, swapped for a canvas+text-layer pair by `renderPdfPage`.
 *  Pure query (constructs and returns; no side effect beyond the detached
 *  node).
 *
 *  `width` here is REQUIRED, not cosmetic — a real bug this file shipped
 *  with initially (caught by viewer-golden's G14, not assumed): `.pdf-viewer-pages`
 *  is `align-items: center` (so a page narrower than the column sits
 *  centered), which means an unstretched block child with NO explicit width
 *  shrinks to its content's intrinsic width — 0, since a fresh placeholder
 *  has no content yet. `aspect-ratio` on a 0-width box computes a 0 HEIGHT
 *  too. A zero-size target is a degenerate case IntersectionObserver
 *  reports as `isIntersecting: true` (ratio 1) as long as its point sits
 *  inside the root's bounds, REGARDLESS of `rootMargin` — so with no
 *  explicit width, every one of a document's placeholders "intersects"
 *  immediately, not just the ones near the viewport, defeating lazy render
 *  entirely (a bug this codebase's own diagnostic confirmed: every entry's
 *  `boundingClientRect` was `{width:0, height:0}` when this width was
 *  missing). A concrete percentage width gives `aspect-ratio` a real box to
 *  compute a real height from, so only placeholders ACTUALLY within
 *  `rootMargin`'s extended window report `isIntersecting`. */
function pagePlaceholder(n: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "pdf-viewer-page";
  el.dataset.page = String(n);
  el.style.width = "90%";
  el.style.aspectRatio = "210 / 297";
  return el;
}

/** "Should a render request go out for this page right now" — mirrors
 *  hwp-viewer.ts's `shouldRenderPage`: false when a request is already in
 *  flight or the page already carries a rendered result, so IntersectionObserver
 *  re-firing on scroll jitter never double-requests it. Pure query. */
function shouldRenderPage(page: number, pending: ReadonlySet<number>, rendered: ReadonlySet<number>): boolean {
  return !pending.has(page) && !rendered.has(page);
}

/** Wire up lazy rendering — real `IntersectionObserver` when the runtime has
 *  one, an eager "render every page immediately" fallback when it doesn't
 *  (jsdom, mirrors hwp-viewer.ts's `observePages`). `onVisible` is the SAME
 *  function either path calls, so there is exactly one "what happens when a
 *  page becomes visible" rule. Command (returns a disconnect handle). */
function observePages(
  root: HTMLElement,
  placeholders: readonly HTMLElement[],
  onVisible: (page: number, el: HTMLElement) => void,
): { disconnect(): void } {
  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          onVisible(pageIndexOf(entry.target as HTMLElement), entry.target as HTMLElement);
        }
      },
      { root, rootMargin: "200% 0px" },
    );
    for (const ph of placeholders) observer.observe(ph);
    return observer;
  }
  for (const ph of placeholders) onVisible(pageIndexOf(ph), ph);
  return { disconnect() {} };
}

/** Render bookkeeping for one open() call — grouped so close()/zoom/eviction
 *  never have to thread five separate maps through function signatures. */
interface PageRenderState {
  pending: Set<number>;
  rendered: Set<number>;
  /** FIFO of currently-rendered page numbers — the render-cap eviction order
   *  (design §"대용량 PDF에서 페이지 캔버스가 무한히 쌓이지 않게"). */
  renderOrder: number[];
  renderTasks: Map<number, { cancel(): void }>;
  textLayers: Map<number, { cancel(): void }>;
}

/** How many rendered pages a single open PDF keeps as live canvases before
 *  evicting the oldest — bounds memory on a large document instead of
 *  accumulating one full-resolution canvas per page forever (MVP cap,
 *  eviction re-renders lazily if scrolled back into view, same "no retry
 *  needed, just re-earn it" shape as hwp-viewer's in-flight guard). */
const MAX_RENDERED_PAGES = 20;

/** Clear a rendered page's canvas/text-layer DOM and drop its render-state
 *  bookkeeping so `shouldRenderPage` treats it as never-rendered again — the
 *  page re-earns a render the next time it scrolls into view. Command
 *  (void). */
function evictPage(pageNum: number, el: HTMLElement | undefined, state: PageRenderState): void {
  state.rendered.delete(pageNum);
  state.renderTasks.get(pageNum)?.cancel();
  state.renderTasks.delete(pageNum);
  state.textLayers.get(pageNum)?.cancel();
  state.textLayers.delete(pageNum);
  if (el) {
    el.replaceChildren();
    el.style.removeProperty("--scale-factor");
    el.style.removeProperty("--total-scale-factor");
  }
}

/** Enforce `MAX_RENDERED_PAGES` after a page finishes rendering — evicts the
 *  single oldest entry in `renderOrder` if the cap is now exceeded (called
 *  once per successful render, so it can never fall more than one page
 *  behind the cap). Command (void). */
function enforceRenderCap(state: PageRenderState, pageEls: ReadonlyMap<number, HTMLElement>): void {
  while (state.renderOrder.length > MAX_RENDERED_PAGES) {
    const oldest = state.renderOrder.shift();
    if (oldest !== undefined && state.rendered.has(oldest)) evictPage(oldest, pageEls.get(oldest), state);
  }
}

/** Request + swap in one page's rendered canvas + text layer (or an error
 *  message on failure), guarded by `shouldRenderPage`. Re-entrant by design
 *  (zoom-change calls this again for an already-rendered page after
 *  `evictPage` clears its bookkeeping) — always computes the CURRENT
 *  `fontScale.get()` at call time, so a page rendered mid-zoom-change picks
 *  up the latest value rather than a stale one captured earlier. Command
 *  (void) — kicks off async IO and mutates `el`/the tracking sets. */
function renderPdfPage(
  page: number,
  el: HTMLElement,
  pdfDoc: PdfDocumentProxy,
  pdfjs: PdfjsModule,
  state: PageRenderState,
  pagesEl: HTMLElement,
  pageEls: ReadonlyMap<number, HTMLElement>,
): void {
  if (!shouldRenderPage(page, state.pending, state.rendered)) return;
  state.pending.add(page);
  (async () => {
    const pdfPage = await pdfDoc.getPage(page);
    const unscaled = pdfPage.getViewport({ scale: 1 });
    const scale = fitWidthScale(unscaled.width, pageTargetWidth(pagesEl), fontScale.get());
    const viewport = pdfPage.getViewport({ scale });

    const outputScale = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const renderTask = pdfPage.render({
      canvas,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
    });
    state.renderTasks.set(page, renderTask);
    await renderTask.promise;

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "pdf-viewer-canvas-wrap";
    canvasWrap.style.width = `${viewport.width}px`;
    canvasWrap.style.height = `${viewport.height}px`;
    canvasWrap.appendChild(canvas);

    // `--scale-factor`/`--total-scale-factor` drive pdfjs-dist's own
    // `pdf_viewer.css` (`.textLayer`'s font-size/position calc chain) — set
    // on the page element so they inherit into the text layer child below,
    // without needing pdfjs-dist's full `.pdfViewer .page` framework markup.
    el.style.setProperty("--scale-factor", String(scale));
    el.style.setProperty("--total-scale-factor", String(scale));
    el.style.aspectRatio = "";
    el.style.width = `${viewport.width}px`;
    el.style.height = `${viewport.height}px`;

    const textLayerEl = document.createElement("div");
    textLayerEl.className = "textLayer";
    textLayerEl.style.width = `${viewport.width}px`;
    textLayerEl.style.height = `${viewport.height}px`;

    el.replaceChildren(canvasWrap, textLayerEl);

    const textContent = await pdfPage.getTextContent();
    const textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: textLayerEl, viewport });
    state.textLayers.set(page, textLayer);
    await textLayer.render();

    state.pending.delete(page);
    state.rendered.add(page);
    state.renderOrder.push(page);
    enforceRenderCap(state, pageEls);
  })().catch((err: unknown) => {
    state.pending.delete(page);
    state.rendered.add(page); // a failed page is terminal — never retried
    el.replaceChildren();
    el.style.aspectRatio = "";
    el.classList.add("pdf-viewer-page-error");
    el.textContent = `페이지를 불러올 수 없습니다: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  });
}

/** Re-render every currently-rendered (not in-flight) page at the current
 *  zoom — called on a `fontScale` change and on window resize. Clears each
 *  page's render bookkeeping via `evictPage` first so `renderPdfPage`'s own
 *  `shouldRenderPage` guard treats it as fresh, then re-requests it — a full
 *  re-raster rather than a CSS transform, so the canvas and its text layer
 *  are always computed from the SAME viewport and stay pixel-aligned (a CSS-
 *  only scale would need the canvas and text layer scaled by an identical
 *  transform to stay aligned, and re-deriving that from two independently
 *  updated boxes is a bigg er source of drift than re-rendering a static
 *  document's pages, which — unlike HWP's raster-only page images — is cheap
 *  relative to a human's zoom-key cadence, a bigger source of drift risk this
 *  design avoids entirely). Command (void). */
function rerenderVisiblePages(
  pdfDoc: PdfDocumentProxy,
  pdfjs: PdfjsModule,
  state: PageRenderState,
  pagesEl: HTMLElement,
  pageEls: ReadonlyMap<number, HTMLElement>,
): void {
  const toRerender = state.renderOrder.filter((p) => state.rendered.has(p) && !state.pending.has(p));
  for (const page of toRerender) {
    const el = pageEls.get(page);
    evictPage(page, el, state);
    state.renderOrder = state.renderOrder.filter((p) => p !== page);
    if (el) renderPdfPage(page, el, pdfDoc, pdfjs, state, pagesEl, pageEls);
  }
}

/** Open `absPath` in the PDF viewer: shell up immediately with a loading
 *  status, then fetch bytes + dynamic-import `pdfjs-dist` + parse in the
 *  background and swap in the page column (or an error status) when ready.
 *  Mirrors hwp-viewer.ts's `openHwpViewer` shape (design: "hwp-viewer가 페이지
 *  렌더 뷰어의 표준 선례"). Command. */
/** Construct the pdf.js worker from a same-origin `blob:` URL instead of the
 *  raw `/pdfjs/build/pdf.worker.mjs` path. In the production Tauri build the
 *  page origin is the custom `tauri://localhost` scheme, and WKWebView
 *  silently fails a module `Worker` loaded DIRECTLY from a custom-scheme URL —
 *  the `Worker` object constructs without throwing but never runs its script,
 *  so `getDocument` never gets a reply and hangs forever ("모달은 뜨는데
 *  렌더링이 안 됨", 사용자 리포트 2026-07-18). This is why neither the golden
 *  (`localhost:1430`) nor `tauri dev` (`localhost:1420`) ever caught it: both
 *  are real http origins where a custom-scheme Worker isn't involved.
 *
 *  Fetching the script (same-origin, allowed by CSP `connect-src 'self'`) and
 *  handing `new Worker` a `blob:` URL sidesteps it — WKWebView runs blob-URL
 *  workers normally (needs CSP `worker-src blob:`, tauri.conf.json). The
 *  worker bundle is self-contained (zero top-level imports) so the opaque blob
 *  base breaks no import resolution, and every asset URL it fetches at runtime
 *  (cMapUrl/standardFontDataUrl/wasmUrl/…) is an absolute `/pdfjs/…` string
 *  getDocument is handed, resolved against the document origin, not the blob
 *  base. Returns the worker plus a `revoke` the caller fires on teardown (the
 *  ~2MB script blob stays referenced by the object URL until then). */
async function makeBlobWorker(scriptUrl: string): Promise<{ worker: Worker; revoke: () => void }> {
  const res = await fetch(scriptUrl);
  if (!res.ok) throw new Error(`pdf worker fetch: ${res.status} ${res.statusText} for ${scriptUrl}`);
  const blobUrl = URL.createObjectURL(await res.blob());
  return { worker: new Worker(blobUrl, { type: "module" }), revoke: () => URL.revokeObjectURL(blobUrl) };
}

/** Install `ReadableStream.prototype[Symbol.asyncIterator]` when the runtime
 *  lacks it. The production WKWebView (Tauri's webview) does NOT implement
 *  async iteration of a ReadableStream, but pdf.js's `getTextContent` does
 *  `for await (const value of readableStream)` (pdf.mjs `streamTextContent`).
 *  Under the real app every text-layer build therefore threw
 *  `TypeError: undefined is not a function (near '...value of readableStream...')`,
 *  and because `renderPdfPage`'s catch clears the page element it also blanked
 *  the canvas that had ALREADY rendered a line earlier — the "모달은 뜨는데
 *  페이지가 비어있고 에러만" report (2026-07-18). Canvas render itself survives
 *  because its sibling path uses `readableStream.getReader()` (supported), not
 *  `for await`.
 *
 *  Neither the CDP golden (Chromium) nor Playwright WebKit reproduces this:
 *  both ship the async iterator, so only a real `tauri build` WKWebView bundle
 *  exposes it (see [[wkwebview-custom-scheme-test-gap]] — same "green
 *  everywhere but the real webview" class).
 *
 *  Feature-detected (`in` guard) → a no-op on engines that already have it, so
 *  the polyfill can only ever ADD the missing method, never shadow a native
 *  one. The body is the Streams-spec definition: a reader's `read()` already
 *  yields `{ value, done }`, exactly an async-iterator result; `return()`
 *  cancels the stream unless `preventCancel`. Idempotent. Command (void).
 *  Exported for the regression test that guards this polyfill (tests/pdf-viewer). */
export function ensureReadableStreamAsyncIterator(): void {
  if (typeof ReadableStream === "undefined") return;
  const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
  if (Symbol.asyncIterator in proto) return;
  proto[Symbol.asyncIterator] = function (
    this: ReadableStream,
    { preventCancel = false }: { preventCancel?: boolean } = {},
  ) {
    const reader = this.getReader();
    return {
      next: () => reader.read(),
      return: (value?: unknown) => {
        if (preventCancel) {
          reader.releaseLock();
          return Promise.resolve({ done: true, value });
        }
        return reader.cancel(value).then(() => {
          reader.releaseLock();
          return { done: true, value };
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
}

function openPdfViewer(absPath: string): ViewerHandle {
  ensureStyleInjected();
  ensureReadableStreamAsyncIterator();
  const content = document.createElement("div");
  content.className = "pdf-viewer-status";
  content.textContent = "문서 불러오는 중…";

  const shell = openViewerShell({ absPath, modalClass: "pdf-viewer", content });

  let observerHandle: { disconnect(): void } | null = null;
  let loadingTask: PdfLoadingTask | null = null;
  let pdfWorker: { destroy(): void } | null = null;
  let revokeWorkerUrl: (() => void) | null = null;
  const rawState: PageRenderState = {
    pending: new Set(),
    rendered: new Set(),
    renderOrder: [],
    renderTasks: new Map(),
    textLayers: new Map(),
  };

  shell.onTeardown(() => observerHandle?.disconnect());
  shell.onTeardown(() => {
    for (const task of rawState.renderTasks.values()) task.cancel();
    for (const layer of rawState.textLayers.values()) layer.cancel();
  });
  shell.onTeardown(() => {
    loadingTask?.destroy().catch(() => {});
    pdfWorker?.destroy();
    revokeWorkerUrl?.();
  });

  (async () => {
    const [bytes, pdfjsMod] = await Promise.all([
      readLocalFileBytes(absPath),
      import("pdfjs-dist") as unknown as Promise<PdfjsModule>,
      import("pdfjs-dist/web/pdf_viewer.css" as string),
    ]);
    const pdfjs = pdfjsMod;

    const { worker: rawWorker, revoke } = await makeBlobWorker("/pdfjs/build/pdf.worker.mjs");
    revokeWorkerUrl = revoke;
    // Surface a worker script load/parse failure that pdf.js's PDFWorker
    // otherwise swallows — without this a worker that fails to boot just hangs
    // getDocument with no message (the exact "renders nothing, no error"
    // failure mode). addEventListener (not onerror) so pdf.js's own port
    // wiring below doesn't overwrite it.
    rawWorker.addEventListener("error", (e: ErrorEvent) => {
      if (!content.classList.contains("pdf-viewer-status")) return; // pages already rendering — ignore
      content.replaceChildren();
      content.textContent = `PDF 워커 오류: ${e.message || "worker failed to load"}`;
    });
    const worker = new pdfjs.PDFWorker({ port: rawWorker });
    pdfWorker = worker;

    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      worker,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      iccUrl: "/pdfjs/iccs/",
      wasmUrl: "/pdfjs/wasm/",
      // Defensive under our strict CSP: pdf.js JIT-compiles PostScript type-4
      // functions / CFF font programs with `new Function` when this is left at
      // its default (true), and our `script-src 'self' 'wasm-unsafe-eval'`
      // allows WebAssembly but NOT `new Function`/eval. pdf.js already
      // auto-disables eval via its own FeatureTest (a `new Function` in
      // try/catch throws EvalError under this CSP), so this is belt-and-braces,
      // not the fix for any specific bug — the "페이지가 비어있고 에러만" report
      // (2026-07-18) was ReadableStream async iteration, not eval; see
      // ensureReadableStreamAsyncIterator above.
      isEvalSupported: false,
    });
    loadingTask = task;
    const doc = await task.promise;

    const placeholders = Array.from({ length: doc.numPages }, (_, i) => pagePlaceholder(i + 1));
    const pageEls = new Map(placeholders.map((el) => [pageIndexOf(el), el]));

    content.className = "pdf-viewer-pages";
    content.replaceChildren(...placeholders);
    // Force a synchronous layout flush BEFORE constructing the observer — a
    // real bug this file shipped with initially (caught by viewer-golden's
    // G14, not assumed from reading IntersectionObserver's spec): without
    // this read, `content`'s flex/overflow box (`.pdf-viewer-pages`,
    // `flex:1; min-height:0; overflow:auto`, set via the className above in
    // this SAME tick) had not yet been resolved by the browser when
    // `observePages` below constructed the observer with `root: content`, so
    // its very first intersection computation used stale/unbounded root
    // geometry and reported nearly every one of a 25-page document's
    // placeholders as intersecting at once — the opposite of "lazy". Reading
    // `clientHeight` (discarded — this call exists ONLY for its layout side
    // effect) forces the browser to resolve that box first.
    void content.clientHeight;

    observerHandle = observePages(content, placeholders, (page, el) =>
      renderPdfPage(page, el, doc, pdfjs, rawState, content, pageEls),
    );

    const unsubscribeZoom = fontScale.bind(() => {
      if (content.classList.contains("pdf-viewer-pages")) rerenderVisiblePages(doc, pdfjs, rawState, content, pageEls);
    });
    shell.onTeardown(unsubscribeZoom);

    const onResize = () => {
      if (content.classList.contains("pdf-viewer-pages")) rerenderVisiblePages(doc, pdfjs, rawState, content, pageEls);
    };
    if (typeof window !== "undefined") {
      window.addEventListener("resize", onResize);
      shell.onTeardown(() => window.removeEventListener("resize", onResize));
    }
  })().catch((err: unknown) => {
    content.replaceChildren();
    content.className = "pdf-viewer-status";
    content.textContent = `문서를 열 수 없습니다: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  });

  return { close: () => shell.close() };
}

const PDF_VIEWER: Viewer = {
  id: "ext.pdf",
  extensions: ["pdf"],
  label: "PDF",
  open: openPdfViewer,
};

/** Register the PDF viewer. Called once from activateExtensions() at boot
 *  (main.ts, before the first document mounts) — registerViewer's own
 *  duplicate-id guard makes a second call a developer error, matching every
 *  other registry in this codebase. Command (void). */
export function registerPdfViewer(): void {
  registerViewer(PDF_VIEWER);
}
