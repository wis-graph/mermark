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
  // NO size envelope here (full-pane rewrite, design §C: "콘텐츠 루트는 이제
  // 아무 width/height도 선언하지 않는다 — 셸 flex가 소유"). `.pdf-viewer` used
  // to carry a fixed `92vw/88vh/max-height:88vh` envelope of its own (a
  // vw/vh-fraction descendant of the pre-rewrite body-level backdrop/modal);
  // now `.viewer-panel`'s `flex:1; min-width:0; min-height:0`
  // (styles.css) is the SOLE size owner —
  // tests/viewer-size-envelope.test.ts's content-root gate asserts this
  // file's injected CSS declares no width/height/max-* on `.pdf-viewer`.
  style.textContent = `
.pdf-viewer-pages {
  flex: 1; min-height: 0; overflow: auto;
  display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 8px 0;
}
.pdf-viewer-page {
  position: relative; background: #fff; box-shadow: none;
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
 *  worth reading in this file's signatures. Exported (along with
 *  `PdfViewport`/`PdfPageProxy`/`PdfDocumentProxy` below) ONLY so
 *  tests/pdf-viewer.test.ts's scheduler tests can type a hand-built,
 *  fully-controllable fake pdfDoc/pdfjs pair (render-task resolution timing
 *  under direct test control) without depending on `pdfjs-dist`'s own types
 *  — nothing else in the app imports these. */
export interface PdfjsModule {
  getDocument(params: Record<string, unknown>): PdfLoadingTask;
  PDFWorker: new (params: { port: Worker }) => { destroy(): void };
  TextLayer: new (params: {
    textContentSource: unknown;
    container: HTMLElement;
    viewport: PdfViewport;
  }) => { render(): Promise<unknown>; cancel(): void };
}
export interface PdfViewport {
  width: number;
  height: number;
}
export interface PdfPageProxy {
  getViewport(params: { scale: number }): PdfViewport;
  getTextContent(): Promise<unknown>;
  render(params: {
    canvas: HTMLCanvasElement;
    viewport: PdfViewport;
    transform?: number[];
  }): { promise: Promise<void>; cancel(): void };
}
export interface PdfDocumentProxy {
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

/** The fraction of the pages column ONE page occupies. Kept in lockstep with
 *  hwp-viewer.ts's `HWP_PAGE_WIDTH_FRACTION` so both document viewers render
 *  pages at the SAME width — change this and the other one together, they are
 *  one design decision. Was 0.9 (사용자 지정 2026-07-18: "hwp 는 90%", and PDF
 *  was rendering at the FULL column width — "과도하게 크게") for a reading
 *  margin either side of the page; **재호출 4차 (팀리드 지시, 2026-07-27,
 *  html/docx 뷰어 정렬)**: the page is still multi-sheet (unlike docx, which
 *  went page-less flat the same day — see that viewer's comment), so a page
 *  boundary must stay legible, but the "page inside a frame" look — margin +
 *  drop shadow — is gone; a page now fills the column edge-to-edge and the
 *  ONLY remaining page-break cue is the gap between `.pdf-viewer-page`
 *  elements (`.pdf-viewer-pages`'s `gap: 12px`) plus the white/surface
 *  background against the (usually non-white) panel background. */
const PDF_PAGE_WIDTH_FRACTION = 1;

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
 *  straight to `pdfDoc.getPage`. Exported (along with `pagePlaceholder`
 *  below) so tests/pdf-viewer.test.ts's scheduler tests can build the same
 *  page-number ⇄ element pairing this file uses internally, rather than
 *  re-deriving `data-page` parsing/writing by hand. */
export function pageIndexOf(el: HTMLElement): number {
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
export function pagePlaceholder(n: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "pdf-viewer-page";
  el.dataset.page = String(n);
  el.style.width = `${PDF_PAGE_WIDTH_FRACTION * 100}%`;
  el.style.aspectRatio = "210 / 297";
  return el;
}

/** "Should a render request go out for this page right now" — mirrors
 *  hwp-viewer.ts's `shouldRenderPage`: false when a request is already in
 *  flight, already carries a rendered result, OR already failed terminally,
 *  so IntersectionObserver re-firing on scroll jitter (or `reconcile`
 *  re-running on every settle) never double-requests it and never retries a
 *  page that already failed. Pure query. */
function shouldRenderPage(
  page: number,
  pending: ReadonlySet<number>,
  rendered: ReadonlySet<number>,
  failed: ReadonlySet<number>,
): boolean {
  return !pending.has(page) && !rendered.has(page) && !failed.has(page);
}

/** Wire up band tracking — real `IntersectionObserver` when the runtime has
 *  one, an eager "every page is in the band immediately" fallback when it
 *  doesn't (jsdom, mirrors hwp-viewer.ts's `observePages`). Unlike the
 *  pre-reconcile version, `onBandChange` is told about BOTH entering AND
 *  leaving the band (`entry.isIntersecting` forwarded either way, not
 *  filtered to entries only) — the caller needs the full "currently in the
 *  200%-margin band" set (`inBand`), not just a one-shot "became visible"
 *  event, so `reconcile` can recompute its target from a set that shrinks as
 *  well as grows. `onBandChange` is still the SAME function either runtime
 *  path calls, so there is exactly one "what does band membership just
 *  become" rule regardless of which branch runs. Command (returns a
 *  disconnect handle). */
function observePages(
  root: HTMLElement,
  placeholders: readonly HTMLElement[],
  onBandChange: (page: number, el: HTMLElement, inBand: boolean) => void,
): { disconnect(): void } {
  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          onBandChange(pageIndexOf(entry.target as HTMLElement), entry.target as HTMLElement, entry.isIntersecting);
        }
      },
      { root, rootMargin: "200% 0px" },
    );
    for (const ph of placeholders) observer.observe(ph);
    return observer;
  }
  for (const ph of placeholders) onBandChange(pageIndexOf(ph), ph, true);
  return { disconnect() {} };
}

/** Render bookkeeping for one open() call — grouped so close()/zoom/eviction
 *  never have to thread five separate maps through function signatures.
 *  `rendered`/`failed` are disjoint terminal outcomes (a page is in at most
 *  one); `pending` overlaps neither — see `shouldRenderPage`. There is no
 *  render-order queue here (contrast the pre-reconcile version's FIFO
 *  `renderOrder`): `reconcile` below recomputes who deserves a render slot
 *  FRESH from current geometry every time it runs, so a persisted queue
 *  would just be a second source of truth to keep in sync with `inBand`.
 *  Exported (along with `MAX_RENDERED_PAGES`/`MAX_CONCURRENT_RENDERS` below)
 *  so tests/pdf-viewer.test.ts's scheduler tests can construct real
 *  scheduler state and assert against these exact caps, instead of
 *  duplicating the numbers or the shape by hand. */
export interface PageRenderState {
  pending: Set<number>;
  rendered: Set<number>;
  /** Terminal render failures — never retried (mirrors hwp-viewer's "a
   *  failed page is terminal" rule). Split out from `rendered` (재호출: used
   *  to be lumped into `rendered` to mark it "settled") purely so a reader
   *  doesn't have to infer "rendered OR failed" from one boolean-ish set —
   *  `reconcile`'s target computation and `shouldRenderPage`'s guard both
   *  read this directly instead of a comment explaining what `rendered`
   *  secretly also means. */
  failed: Set<number>;
  renderTasks: Map<number, { cancel(): void }>;
  textLayers: Map<number, { cancel(): void }>;
}

/** How many rendered pages a single open PDF keeps as live canvases before
 *  evicting the FARTHEST-from-viewport-center one — bounds memory on a
 *  large document instead of accumulating one full-resolution canvas per
 *  page forever (MVP cap; eviction re-renders lazily if scrolled back into
 *  view, same "no retry needed, just re-earn it" shape as hwp-viewer's
 *  in-flight guard). Eviction order is DISTANCE-based, not FIFO — see
 *  `reconcile`'s own comment for why a push-order queue silently blanked
 *  onscreen pages in a tall/zoomed panel. */
export const MAX_RENDERED_PAGES = 20;

/** How many `renderPdfPage` calls this viewer lets run at once. pdf.js hands
 *  `getDocument()` a SINGLE `PDFWorker` per open document — every render
 *  (raster AND, after it, text-layer build) queues on that ONE worker thread
 *  regardless of how many `renderPdfPage` calls are in flight, so firing
 *  several at once never makes them finish sooner; it only lets an
 *  IntersectionObserver callback that sees 5-10 pages enter the band in one
 *  frame (`observePages`' 200% rootMargin × a tall panel) dispatch all of
 *  them simultaneously, and the worker resolves them in a burst instead of
 *  one at a time nearest-to-farthest (사용자 리포트: "스크롤하다 갑자기 연달아
 *  로드된다"). A named constant (not inlined `1`) so a future multi-worker
 *  pdf.js setup has one place to raise it — `reconcile` reads it as a plain
 *  slot count, unaware of the pdf.js-worker reasoning above. */
export const MAX_CONCURRENT_RENDERS = 1;

/** Clear a rendered page's canvas/text-layer DOM and drop its render-state
 *  bookkeeping so `shouldRenderPage` treats it as never-rendered again — the
 *  page re-earns a render the next time `reconcile` decides it belongs in
 *  the target set again (never called on a `failed` page — a failure is
 *  terminal, not something to re-earn). Command (void). */
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

/** The pages column's current vertical center, in VIEWPORT coordinates
 *  (`getBoundingClientRect()`, not `offsetTop`/`scrollTop`). Read ONCE per
 *  `reconcile` call and threaded through rather than re-read per page inside
 *  a sort comparator — ranking N in-band pages by distance then costs one
 *  layout read, not up to N of them. See `distanceFromViewportCenter`'s
 *  comment for why viewport coordinates, not `offsetTop`. Pure query. */
function viewportCenterOf(pagesEl: HTMLElement): number {
  const rect = pagesEl.getBoundingClientRect();
  return rect.top + rect.height / 2;
}

/** How far a page element's own center sits from the viewport's current
 *  center (`viewportCenterOf`, computed once per `reconcile` call and passed
 *  in here — see that function's comment on why). This is the ONE ranking
 *  `reconcile` uses for both halves of its job: which currently-rendered
 *  pages survive the `MAX_RENDERED_PAGES` cap, and which not-yet-rendered
 *  page earns the next render slot — using the same number both times means
 *  the two decisions can never disagree about what "close" means.
 *
 *  Uses `getBoundingClientRect()` (viewport coordinates), NOT
 *  `offsetTop`/`offsetHeight` (coordinates relative to the element's
 *  `offsetParent`) — a real coordinate-space bug this scheduler shipped
 *  with initially: this file's injected `.pdf-viewer-pages` rule (the CSS
 *  for `pagesEl`) declares no `position`, so `pagesEl` is never a page
 *  element's `offsetParent`, and `offsetTop` measured from whatever
 *  ancestor actually IS positioned — unrelated to `pagesEl`'s own content
 *  box that `viewportCenterOf` was reading. The two functions were silently
 *  comparing numbers from two different coordinate origins, off by a
 *  constant equal to "nearest positioned ancestor's top → `pagesEl`'s
 *  content top" (small today, roughly a header's height — but an ancestor
 *  CSS change that adds or removes a `position` declaration anywhere above
 *  `pagesEl` would move that constant arbitrarily, in the worst case all
 *  the way out to `document.body`). `getBoundingClientRect()` is always
 *  viewport-relative regardless of any ancestor's `position`, so both
 *  functions now agree on the same coordinate space with no `offsetParent`
 *  assumption at all — and `pagesEl.scrollTop` is no longer needed either;
 *  scroll position is already baked into `getBoundingClientRect()`. Pure
 *  query. */
function distanceFromViewportCenter(el: HTMLElement, viewportCenter: number): number {
  const rect = el.getBoundingClientRect();
  return Math.abs(rect.top + rect.height / 2 - viewportCenter);
}

/** Rank `pages` by `distanceFromViewportCenter` (nearest first) and return at
 *  most `limit` of them — the single sort `reconcile` uses for BOTH "which
 *  in-band pages deserve to stay in the render target" and "which
 *  not-yet-rendered target page gets the next free render slot", so there is
 *  never a second, subtly different idea of "closest" between the two. A
 *  page number with no matching element (should not happen — defensive) is
 *  dropped rather than sorted as though it were distance 0. Pure query. */
function pagesNearestCenter(
  pages: ReadonlySet<number>,
  pageEls: ReadonlyMap<number, HTMLElement>,
  viewportCenter: number,
  limit: number,
): number[] {
  return Array.from(pages)
    .flatMap((page) => {
      const el = pageEls.get(page);
      return el ? [{ page, distance: distanceFromViewportCenter(el, viewportCenter) }] : [];
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((x) => x.page);
}

/** The scheduler's single "make reality match intent" step. Call it after
 *  ANY event that can change either half of that match: a page entering or
 *  leaving the 200%-margin band (`observePages`'s callback), or a render
 *  settling — success OR failure (`renderPdfPage`'s `onSettled`). It
 *  recomputes the target set FRESH from `inBand` every call instead of
 *  trusting a previously computed order, so there is no separate queue
 *  object that can drift out of sync with "what's actually in the band right
 *  now": a page that leaves the band before its turn simply stops being a
 *  candidate next time this runs, and a page evicted while STILL in the band
 *  gets picked back up the very next call that runs `reconcile` for any
 *  reason — no re-fire of ITS OWN IntersectionObserver entry required (see
 *  the eviction-order note below for why that distinction matters).
 *
 *  WHY DISTANCE, NOT FIFO (this scheduler used to track a push-order
 *  `renderOrder` queue and evict the single oldest entry once a render
 *  finished): shrink the panel — zoom in, or a narrower window — so MORE
 *  than `MAX_RENDERED_PAGES` pages sit inside the 200%-margin band at once,
 *  and FIFO evicts whichever page happened to render FIRST, which on a
 *  document tall enough to fill the panel is very often a page still ON
 *  SCREEN. Because that page's element never stops intersecting (it's still
 *  inside the band), its OWN IntersectionObserver entry never re-fires, so
 *  nothing was left to re-request its render under the old "render on
 *  observer entry" rule — a permanently blank page until the user actually
 *  scrolled it out of the (200%-wide) band and back in. Ranking by distance
 *  from the viewport's real center instead means the FARTHEST in-band page
 *  is always the one evicted, so a page genuinely on screen is the very last
 *  thing this function ever gives up — and even if it IS evicted (a
 *  temporary ranking loss to a nearer page), the next `reconcile` call
 *  (triggered by some OTHER page's observer event or render settling, which
 *  keeps happening as the user scrolls) re-evaluates it fresh rather than
 *  waiting on an observer entry that may never come.
 *
 *  WHY CONCURRENCY 1 (`MAX_CONCURRENT_RENDERS`), NOT "however many pages
 *  entered the band this frame": see that constant's own comment — pdf.js's
 *  single worker serializes the real work anyway, so this only controls how
 *  many `renderPdfPage` calls are in flight at once, closest-first, instead
 *  of bursting every band-entrant out simultaneously.
 *
 *  Failed pages (`state.failed`) are excluded from the target computation
 *  itself, not just from the render-candidate filter — otherwise a
 *  terminally-failed page could still occupy one of the `MAX_RENDERED_PAGES`
 *  ranked slots and crowd out a real, renderable page that happens to sit
 *  just past it.
 *
 *  Command (void) — mutates `state` via `evictPage` and fires `startRender`
 *  for however many pages currently have a free slot. `startRender` is
 *  expected to eventually call `reconcile` again on settle (wired in
 *  `openPdfViewer` below via `renderPdfPage`'s `onSettled`), which is what
 *  makes a freed slot or a newly-eligible target get picked up without
 *  waiting on another IntersectionObserver event.
 *
 *  Exported (along with `renderPdfPage` below) so tests/pdf-viewer.test.ts
 *  can drive the scheduler directly — concurrency cap, distance-based
 *  eviction, and the "evicted-but-still-in-band page gets re-queued with no
 *  observer re-fire" regression guard — without mocking pdf.js's dynamic
 *  import, Worker, or fetch, none of which this scheduler logic touches. */
export function reconcile(
  state: PageRenderState,
  inBand: ReadonlySet<number>,
  pageEls: ReadonlyMap<number, HTMLElement>,
  viewportCenter: number,
  startRender: (page: number, el: HTMLElement) => void,
): void {
  const eligible = new Set(Array.from(inBand).filter((page) => !state.failed.has(page)));
  const target = new Set(pagesNearestCenter(eligible, pageEls, viewportCenter, MAX_RENDERED_PAGES));

  for (const page of Array.from(state.rendered)) {
    if (!target.has(page)) evictPage(page, pageEls.get(page), state);
  }

  const freeSlots = MAX_CONCURRENT_RENDERS - state.pending.size;
  if (freeSlots <= 0) return;

  const wanting = new Set(
    Array.from(target).filter((page) => shouldRenderPage(page, state.pending, state.rendered, state.failed)),
  );
  for (const page of pagesNearestCenter(wanting, pageEls, viewportCenter, freeSlots)) {
    const el = pageEls.get(page);
    if (el) startRender(page, el);
  }
}

/** Request + swap in one page's rendered canvas + text layer (or an error
 *  message on failure), guarded by `shouldRenderPage` (redundant with
 *  `reconcile`'s own `shouldRenderPage` filter on its candidates, kept here
 *  too so this function stays safe to call directly — e.g. from a test —
 *  without going through `reconcile` first). Re-entrant by design (a window
 *  resize OR a zoom change calls this again for an already-rendered page
 *  after `evictPage` clears its bookkeeping) — always reads the CURRENT
 *  `pageTargetWidth(pagesEl)` AND the caller-supplied `zoomFactor` at call
 *  time (`shell.zoom.get()`, design §B's per-viewer BEHAVIOR table: PDF is a
 *  "재래스터" viewer, never a CSS transform), so a page rendered mid-resize/
 *  mid-zoom fits the latest panel width and zoom rather than a stale one
 *  captured earlier. `onSettled` fires exactly once, on EITHER outcome
 *  (success or the catch below) — `openPdfViewer` wires it to re-run
 *  `reconcile` so a freed concurrency slot or a newly-terminal page gets
 *  picked up immediately, without waiting on another IntersectionObserver
 *  event. Command (void) — kicks off async IO and mutates `el`/the tracking
 *  sets. */
export function renderPdfPage(
  page: number,
  el: HTMLElement,
  pdfDoc: PdfDocumentProxy,
  pdfjs: PdfjsModule,
  state: PageRenderState,
  pagesEl: HTMLElement,
  zoomFactor: number,
  onSettled: () => void,
): void {
  if (!shouldRenderPage(page, state.pending, state.rendered, state.failed)) return;
  state.pending.add(page);
  (async () => {
    const pdfPage = await pdfDoc.getPage(page);
    const unscaled = pdfPage.getViewport({ scale: 1 });
    const scale = fitWidthScale(unscaled.width, pageTargetWidth(pagesEl), zoomFactor);
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
    onSettled();
  })().catch((err: unknown) => {
    state.pending.delete(page);
    state.failed.add(page); // terminal — never retried; excluded from reconcile's target AND eviction
    el.replaceChildren();
    el.style.aspectRatio = "";
    el.classList.add("pdf-viewer-page-error");
    el.textContent = `페이지를 불러올 수 없습니다: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
    onSettled();
  });
}

/** Evict every currently-rendered page so `reconcile` re-requests each one at
 *  the CURRENT panel width/zoom — called by `refitPages` below on a window
 *  resize OR a viewer-local zoom change (design §B: "resize 핸들러와 동일
 *  가드로 refitPages에 합류" — one re-raster rule regardless of trigger).
 *  Deliberately does NOT re-render anything itself (contrast the pre-
 *  reconcile version, which called `renderPdfPage` for every evicted page
 *  right here, all at once, unbounded): eviction only clears bookkeeping via
 *  `evictPage`; the CALLER runs `reconcile` immediately after, which re-
 *  requests the evicted pages through the SAME one-in-flight
 *  (`MAX_CONCURRENT_RENDERS`) queue a scroll does, nearest-to-viewport-center
 *  first — so a resize/zoom on a large open document re-rasters gradually
 *  instead of firing every visible page's re-render simultaneously. A full
 *  re-raster rather than a CSS transform, so the canvas and its text layer
 *  are always computed from the SAME viewport and stay pixel-aligned (a
 *  CSS-only scale would need the canvas and text layer scaled by an
 *  identical transform to stay aligned, and re-deriving that from two
 *  independently updated boxes is a bigger source of drift than re-rendering
 *  a static document's pages, which — unlike HWP's raster-only page images —
 *  is cheap relative to a human's resize/zoom-click cadence). Command
 *  (void). */
function rerenderVisiblePages(state: PageRenderState, pageEls: ReadonlyMap<number, HTMLElement>): void {
  for (const page of Array.from(state.rendered)) {
    evictPage(page, pageEls.get(page), state);
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

  const shell = openViewerShell({ absPath, paneClass: "pdf-viewer", content });

  let observerHandle: { disconnect(): void } | null = null;
  let loadingTask: PdfLoadingTask | null = null;
  let pdfWorker: { destroy(): void } | null = null;
  let revokeWorkerUrl: (() => void) | null = null;
  const rawState: PageRenderState = {
    pending: new Set(),
    rendered: new Set(),
    failed: new Set(),
    renderTasks: new Map(),
    textLayers: new Map(),
  };
  // The band-membership set `reconcile` reads every time it runs — mutated
  // ONLY by the `observePages` callback below (entries add, exits delete),
  // so "what's in the band right now" always matches the observer's most
  // recent word regardless of how many pages have rendered/evicted since.
  const inBand = new Set<number>();

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

    // The single "make reality match intent" entry point for this open()
    // call — everything that can change either half of that match
    // (band membership OR a render settling) funnels through this one
    // closure, which is what lets `reconcile` recompute from CURRENT
    // geometry/state every time instead of each call site duplicating its
    // own "what should render now" logic (see `reconcile`'s own comment for
    // the full why).
    const runReconcile = (): void => {
      reconcile(rawState, inBand, pageEls, viewportCenterOf(content), (page, el) =>
        renderPdfPage(page, el, doc, pdfjs, rawState, content, shell.zoom.get(), runReconcile),
      );
    };

    observerHandle = observePages(content, placeholders, (page, _el, nowInBand) => {
      if (nowInBand) inBand.add(page);
      else inBand.delete(page);
      runReconcile();
    });

    // A page is fit to the panel width INDEPENDENT of the editor's body-text
    // zoom (fontScale) — a document viewer should show the whole page, not
    // inherit "cmd +/-" and render 1.5× the column so it overflows and clips
    // (사용자 리포트 2026-07-18: "본문보다 2배 커보여, 컨텐츠가 다 안 보임").
    // Instead it's fit to the shell's OWN viewer-local zoom (design §B) —
    // `refitPages` is the single "when does a page need to be redrawn at a
    // new scale" rule, triggered by EITHER a window resize (panel width
    // changed) or a zoom-ladder click (shell.zoom.bind, factor changed),
    // never by fontScale. Evicts through `rerenderVisiblePages`, then hands
    // off to `runReconcile` — a resize/zoom never re-renders more than
    // `MAX_CONCURRENT_RENDERS` page(s) at once, same as scroll.
    const refitPages = (): void => {
      if (content.classList.contains("pdf-viewer-pages")) {
        rerenderVisiblePages(rawState, pageEls);
        runReconcile();
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("resize", refitPages);
      shell.onTeardown(() => window.removeEventListener("resize", refitPages));
    }
    shell.onTeardown(shell.zoom.bind(refitPages));
  })().catch((err: unknown) => {
    content.replaceChildren();
    content.className = "pdf-viewer-status";
    content.textContent = `문서를 열 수 없습니다: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  });

  // onClose forwards the shell teardown so the OPENER learns about closes
  // it did not initiate (Esc / header ✕) — see ViewerHandle.onClose.
  return { close: () => shell.close(), onClose: (cb) => shell.onTeardown(cb) };
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
