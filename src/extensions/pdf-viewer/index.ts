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
  /* flex: none is LOAD-BEARING, not tidiness. \`.pdf-viewer-pages\` above is a
     COLUMN flex container, so the main axis is vertical and the default
     \`flex-shrink: 1\` applies to HEIGHT. The container's height is definite
     (\`flex: 1\` from the panel) while the page column overflows it by orders
     of magnitude (a 122-page A4 document is ~240,000px of content in a
     ~900px box), so every page gets squashed down toward its
     \`min-height: auto\` — and that minimum DIFFERS BY RENDER STATE: a
     rendered page contains a canvas and cannot shrink below it, while an
     empty placeholder has no content and collapses toward zero. The column's
     total height therefore lurched by thousands of px every time a page
     rendered or was evicted, yanking the scrollbar and the scroll position
     with it (사용자 리포트 2026-08-17: "스크롤이 아주 지멋대로", on a file whose
     pages are already A4 so \`documentPageAspect\` bought it nothing). Pages in
     a scrolling column must never flex; their size comes from the aspect
     ratio (placeholder) or the rendered viewport (canvas), never from the
     leftover space in a container they are supposed to overflow. */
  flex: none;
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

/** A page's aspect ratio as a CSS `aspect-ratio` value (`"width / height"`),
 *  derived from a real `getViewport({scale:1})` reading — never simplified
 *  or rounded, since CSS `aspect-ratio` accepts any two numbers as-is. Pure
 *  query. Exported (along with `documentPageAspect`/`FALLBACK_PAGE_ASPECT`
 *  below) so tests/pdf-viewer.test.ts's placeholder-aspect regression can
 *  assert the exact ratio a real book's page produces, instead of
 *  hand-computing "width/height" inline and hoping it matches this file's
 *  own formatting. */
export function aspectRatioOf(viewport: PdfViewport): string {
  return `${viewport.width} / ${viewport.height}`;
}

/** A4 portrait (210mm x 297mm) — the placeholder aspect ratio used ONLY when
 *  page 1's own viewport can't be read (`documentPageAspect`'s catch below).
 *  Exported so the fallback path has one named value to assert against in
 *  tests, instead of a bare `"210 / 297"` string duplicated between source
 *  and test. */
export const FALLBACK_PAGE_ASPECT = "210 / 297";

/** The aspect ratio EVERY placeholder in this document is built with — read
 *  ONCE from page 1, right after `getDocument()` resolves and before any
 *  placeholder exists. `getPage(1)` + `getViewport({scale:1})` only parses
 *  that page's dictionary (its bounding box), not its content stream, so
 *  this is far cheaper than a real `renderPdfPage` call.
 *
 *  WHY THIS EXISTS (실측, not a guess): a real 1134-page/174MB book (Gödel,
 *  Escher, Bach) measures 1840x2650 CSS px per page — aspect ratio 0.6943 —
 *  against this file's OLD hardcoded A4 guess of 210/297 = 0.7071. Every
 *  time a placeholder was swapped for its real canvas (`renderPdfPage`
 *  clearing `el.style.aspectRatio` and setting real width/height), that
 *  ONE page grew ~1.85% taller — about 23px at a 900px column width — and
 *  every page below it in the column got shoved down by that amount. The
 *  200%-margin prefetch band (`observePages`) reaches ABOVE the viewport
 *  too, so pages rendering there pushed the content the reader was
 *  actually looking at DOWN, and several renders landing close together
 *  compounded it — 사용자 리포트 (2026-08-17): "스크롤보다 로드가 느려서
 *  한번에 파파박 다급하게 로드되면서 페이지가 급변해". Reading the
 *  document's OWN page 1 instead of guessing A4 makes a placeholder's
 *  height already correct for a UNIFORM-page-size document, so the later
 *  canvas swap changes width/height by ~0.
 *
 *  LIMITATION (by design, not missed): a document whose pages are NOT all
 *  the same size is only PARTIALLY fixed by this — page 1's ratio becomes
 *  every OTHER page's placeholder guess too, so a page whose real box
 *  genuinely differs from page 1's still jumps when its own canvas swaps
 *  in. Fixing that fully would mean reading every page's dictionary up
 *  front before rendering anything, which the actual reported case (a
 *  uniform-page book) does not need — this targets "every page jumps",
 *  not the rarer mixed-page-size edge case, which keeps falling back to
 *  the existing "a page corrects to its own real box when it renders"
 *  behavior.
 *
 *  Falls back to `FALLBACK_PAGE_ASPECT` when page 1 itself can't be read
 *  (defensive — should not normally happen for a document that already
 *  resolved `getDocument()`). Exported for the same reason as
 *  `aspectRatioOf`. Command (async IO; no mutation). */
export async function documentPageAspect(doc: PdfDocumentProxy): Promise<string> {
  try {
    const page1 = await doc.getPage(1);
    return aspectRatioOf(page1.getViewport({ scale: 1 }));
  } catch {
    return FALLBACK_PAGE_ASPECT;
  }
}

/** Build one page's placeholder element — an empty column slot, swapped for
 *  a canvas+text-layer pair by `renderPdfPage`/`renderTextLayer`. Pure query
 *  (constructs and returns; no side effect beyond the detached node).
 *
 *  `aspect` defaults to `FALLBACK_PAGE_ASPECT` (A4) so every existing
 *  scheduler test in tests/pdf-viewer.test.ts that calls `pagePlaceholder(n)`
 *  for pure geometry (distance/eviction — aspect ratio is irrelevant there)
 *  keeps working unchanged; `openPdfViewer` always passes the real
 *  `documentPageAspect(doc)` result explicitly.
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
export function pagePlaceholder(n: number, aspect: string = FALLBACK_PAGE_ASPECT): HTMLElement {
  const el = document.createElement("div");
  el.className = "pdf-viewer-page";
  el.dataset.page = String(n);
  el.style.width = `${PDF_PAGE_WIDTH_FRACTION * 100}%`;
  el.style.aspectRatio = aspect;
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

/** `shouldRenderPage`'s text-layer counterpart — same three-set disjointness
 *  contract (`textLayerPending`/`textLayerRendered`/`textLayerFailed`
 *  instead of the canvas trio), reused rather than duplicated inline so both
 *  guards read as the same rule applied to two different tracks. Pure
 *  query. */
function shouldBuildTextLayer(
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
  /** `pending`/`rendered`/`failed` now track the CANVAS only (재호출,
   *  2026-08-17: text-layer bookkeeping split into its own three sets below
   *  — see `renderTextLayer`'s comment for why canvas and text layer are no
   *  longer one atomic step). `rendered` means "a DRAFT (or better) canvas
   *  is on screen", not "page fully done" — text layer AND full-resolution
   *  sharpening are separate follow-up work (see `fullQuality`/
   *  `sharpenPending`/`sharpenFailed` below). */
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
  /** Text-layer counterpart of `pending`/`rendered`/`failed` — a page only
   *  ever enters these sets AFTER its canvas is in `rendered` (see
   *  `textLayerCandidates`'s `state.rendered` filter), and never both
   *  `pending` and `rendered` at once (same disjointness contract as the
   *  canvas trio, see `shouldBuildTextLayer`). `textLayerFailed` is
   *  terminal only WITHIN one canvas render's lifetime — `evictPage` resets
   *  it on a full re-earn, unlike canvas `failed` (see that function's own
   *  comment for the asymmetry). */
  textLayerPending: Set<number>;
  textLayerRendered: Set<number>;
  textLayerFailed: Set<number>;
  textLayers: Map<number, { cancel(): void }>;
  /** SHARPEN bookkeeping (재호출, 2026-08-17: progressive draft-then-sharp
   *  raster — see `DRAFT_OUTPUT_SCALE`'s own comment for the full "왜"). A
   *  page enters `fullQuality` the moment its ON-SCREEN canvas is rendered
   *  at `fullOutputScale()` resolution — either because `sharpenPdfPage`
   *  upgraded it, or because `renderPdfPage`'s draft pass already WAS full
   *  quality (`draftIsFullQuality()`, non-Retina). `sharpenPending`/
   *  `sharpenFailed` mirror the text-layer trio's disjointness contract
   *  (see `needsSharpening`) — `sharpenFailed` is terminal only WITHIN one
   *  canvas render's lifetime, same asymmetry as `textLayerFailed`
   *  (`evictPage` resets it on a full re-earn). A sharpen failure is NEVER
   *  shown to the reader (team-lead spec: the draft canvas already on
   *  screen stays exactly as it was) — contrast canvas `failed`, which
   *  blanks the page and shows an error because there'd otherwise be
   *  nothing on screen at all. */
  fullQuality: Set<number>;
  sharpenPending: Set<number>;
  sharpenFailed: Set<number>;
  sharpenTasks: Map<number, { cancel(): void }>;
}

/** How many rendered pages a single open PDF keeps as live canvases before
 *  evicting the FARTHEST-from-viewport-center one — bounds memory on a
 *  large document instead of accumulating one full-resolution canvas per
 *  page forever (MVP cap; eviction re-renders lazily if scrolled back into
 *  view, same "no retry needed, just re-earn it" shape as hwp-viewer's
 *  in-flight guard). Eviction order is DISTANCE-based, not FIFO — see
 *  `reconcile`'s own comment for why a push-order queue silently blanked
 *  onscreen pages in a tall/zoomed panel.
 *
 *  20 → 10 (team-lead spec, 2026-08-17, 실측): on Retina a canvas backs its
 *  CSS pixels at `devicePixelRatio` (2), so a 900 CSS-px-wide page renders a
 *  ~1800x2590 device-px canvas — ≈4.7M pixels, ≈19MB of backing store at 4
 *  bytes/pixel (RGBA). 20 live canvases was therefore ≈370MB for one open
 *  document. The 200%-margin prefetch band (`observePages`) only ever holds
 *  roughly 5-7 pages at typical panel heights/zoom, so 20 was headroom far
 *  past what the band ever asks for; 10 (≈190MB worst case) still leaves
 *  room for a shrunk/zoomed panel to widen the eligible set (test (b)/(c)
 *  below) without approaching the old ceiling. */
export const MAX_RENDERED_PAGES = 10;

/** How close (as a fraction of the pages panel's own on-screen height) a
 *  CANVAS-rendered page's center must sit to the viewport's center before
 *  it's worth paying for a text layer — half the panel height either side,
 *  i.e. roughly "on screen or one screen-height away", a much tighter
 *  window than the 200%-margin prefetch band that decides canvas
 *  eligibility. Reuses `distanceFromViewportCenter`, the SAME ranking
 *  `reconcile` already uses for canvas priority, so "close" means one thing
 *  in this file (see `textLayerCandidates`). Named per §7 — a reader
 *  shouldn't have to infer "half the panel" from a bare `0.5`. */
const TEXT_LAYER_DISTANCE_FRACTION = 0.5;

/** How many `renderTextLayer` calls run at once — kept at 1, same reasoning
 *  as `MAX_CONCURRENT_RENDERS`: building hundreds of absolutely-positioned
 *  spans is main-thread work, and letting several pages' text layers build
 *  simultaneously would recreate the exact "several heavy DOM ops land in
 *  one frame" burst this whole change exists to avoid — just for text
 *  layers instead of canvases. */
const MAX_CONCURRENT_TEXT_LAYERS = 1;

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

/** How many `sharpenPdfPage` calls run at once — 1, same reasoning as
 *  `MAX_CONCURRENT_RENDERS`: pdf.js serializes ALL real work (draft AND
 *  sharpen rasters alike) on the ONE `PDFWorker` a document gets, so this
 *  only bounds how many sharpen requests `reconcile` has outstanding, not
 *  how fast any of them resolve. Named separately from
 *  `MAX_CONCURRENT_RENDERS` (rather than reusing it) so a future tuning pass
 *  can raise/lower either slot count independently — they already run at
 *  different priorities (see `reconcile`'s sharpen step, gated on
 *  `state.pending.size === 0`), so there's no reason they'd need to share
 *  one number. */
export const MAX_CONCURRENT_SHARPEN_RENDERS = 1;

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
  state.textLayerPending.delete(pageNum);
  state.textLayerRendered.delete(pageNum);
  // Unlike canvas `failed` (a TRUE terminal outcome — a failed page is
  // excluded from `reconcile`'s target set entirely and never evicted
  // again), a text-layer failure is only terminal for THIS canvas render.
  // This eviction is a full re-earn (the caller re-requests the canvas from
  // scratch), so the next text-layer attempt deserves a fresh try rather
  // than inheriting a failure from a render this page no longer has.
  state.textLayerFailed.delete(pageNum);
  // SHARPEN bookkeeping — same "full re-earn" reasoning as the text-layer
  // reset just above: the draft canvas this eviction just threw away is
  // gone, so the page's NEXT draft render deserves a fresh
  // `fullQuality`/sharpen attempt rather than inheriting either from a
  // canvas that no longer exists.
  state.sharpenTasks.get(pageNum)?.cancel();
  state.sharpenTasks.delete(pageNum);
  state.sharpenPending.delete(pageNum);
  state.sharpenFailed.delete(pageNum);
  state.fullQuality.delete(pageNum);
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
 *  TEXT LAYERS (재호출, 2026-08-17): after the canvas half above, this
 *  function ALSO reconciles text-layer bookkeeping via `textLayerOptions` —
 *  folded INTO this same call rather than a second exported scheduler
 *  function with its own trigger wiring, so "call `reconcile`" is still the
 *  ONE thing that needs to happen after any band-change/settle event (팀리드
 *  spec: "reconcile이 계속 단일 수렴 지점이어야 한다"). `textLayerOptions` is
 *  optional and skipped entirely when omitted — tests/pdf-viewer.test.ts's
 *  canvas-only scheduler tests (a)-(c) call the 5-arg form and never touch
 *  text-layer state at all. The text-layer step ONLY runs when BOTH
 *  `state.pending` AND `state.sharpenPending` are empty (no draft render
 *  and no sharpen render in flight) — "캔버스 작업이 남아 있으면 텍스트
 *  레이어보다 캔버스를 먼저" (team-lead spec) extended to sharpen: filling a
 *  visible page with pixels (draft OR sharp) always outranks building spans
 *  for a page that already has them. See `textLayerCandidates` for the
 *  near-viewport distance filter itself.
 *
 *  SHARPEN (재호출, 2026-08-17, progressive draft→sharp raster — see
 *  `DRAFT_OUTPUT_SCALE`'s comment for the full "왜"): folded in via the
 *  optional `sharpenOptions`, same "one convergence point" reasoning as
 *  `textLayerOptions` above, and placed between the draft step and the
 *  text-layer step in this function's BODY — the actual priority order this
 *  one call enforces is **[evict → draft → sharpen → text layer]**. The
 *  sharpen step is entirely skipped while ANY draft render is
 *  pending/queued (`state.pending.size === 0` gate) — a fast scroll that
 *  keeps drafts landing back-to-back never competes with them for the
 *  single pdf.js worker; the moment drafts catch up, the NEXT `reconcile`
 *  call (triggered by `renderPdfPage`'s `onSettled`, same convergence
 *  mechanism as everything else here) picks sharpening back up
 *  automatically, no separate scheduler required. Candidates come from
 *  `sharpenCandidates` (nearest-viewport-center first, same ranking as
 *  everything else in this file) and are capped at
 *  `MAX_CONCURRENT_SHARPEN_RENDERS`, mirroring the draft step's own
 *  concurrency gate. `sharpenOptions` parameter is placed AFTER
 *  `textLayerOptions` (not between draft and text-layer, despite that being
 *  the execution order) so tests/pdf-viewer.test.ts's existing (e) — a
 *  6-positional-arg call passing `textLayerOptions` as the 6th argument —
 *  keeps compiling and behaving unchanged; a function's parameter order and
 *  its body's execution order are independent choices.
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
  textLayerOptions?: { panelHeight: number; startTextLayer: (page: number, el: HTMLElement) => void },
  sharpenOptions?: { startSharpen: (page: number, el: HTMLElement) => void },
): void {
  const eligible = new Set(Array.from(inBand).filter((page) => !state.failed.has(page)));
  const target = new Set(pagesNearestCenter(eligible, pageEls, viewportCenter, MAX_RENDERED_PAGES));

  for (const page of Array.from(state.rendered)) {
    if (!target.has(page)) evictPage(page, pageEls.get(page), state);
  }

  const freeSlots = MAX_CONCURRENT_RENDERS - state.pending.size;
  if (freeSlots > 0) {
    const wanting = new Set(
      Array.from(target).filter((page) => shouldRenderPage(page, state.pending, state.rendered, state.failed)),
    );
    for (const page of pagesNearestCenter(wanting, pageEls, viewportCenter, freeSlots)) {
      const el = pageEls.get(page);
      if (el) startRender(page, el);
    }
  }

  if (sharpenOptions && state.pending.size === 0) {
    const sharpenFreeSlots = MAX_CONCURRENT_SHARPEN_RENDERS - state.sharpenPending.size;
    if (sharpenFreeSlots > 0) {
      const wantingSharp = sharpenCandidates(state, target, pageEls, viewportCenter, sharpenFreeSlots);
      for (const page of wantingSharp) {
        const el = pageEls.get(page);
        if (el) sharpenOptions.startSharpen(page, el);
      }
    }
  }

  if (!textLayerOptions || state.pending.size > 0 || state.sharpenPending.size > 0) return;
  const textFreeSlots = MAX_CONCURRENT_TEXT_LAYERS - state.textLayerPending.size;
  if (textFreeSlots <= 0) return;
  const wantingText = textLayerCandidates(state, inBand, pageEls, viewportCenter, textLayerOptions.panelHeight, textFreeSlots);
  for (const page of wantingText) {
    const el = pageEls.get(page);
    if (el) textLayerOptions.startTextLayer(page, el);
  }
}

/** The pages `reconcile`'s text-layer step should build next, ranked nearest
 *  first (same `pagesNearestCenter` sort canvas scheduling uses) and capped
 *  at `limit`. A page qualifies only if its CANVAS already rendered
 *  (`state.rendered` — never build text ahead of the pixels it overlays),
 *  it's still in-band, it doesn't already have a text layer pending/built/
 *  terminally-failed (`shouldBuildTextLayer`), AND its distance from the
 *  viewport center is within `TEXT_LAYER_DISTANCE_FRACTION` of `panelHeight`
 *  — a page merely inside the wider 200%-margin prefetch band gets a canvas
 *  but not necessarily a text layer; only a page actually near what's on
 *  screen does. Pure query. */
function textLayerCandidates(
  state: PageRenderState,
  inBand: ReadonlySet<number>,
  pageEls: ReadonlyMap<number, HTMLElement>,
  viewportCenter: number,
  panelHeight: number,
  limit: number,
): number[] {
  const threshold = panelHeight * TEXT_LAYER_DISTANCE_FRACTION;
  const eligible = new Set(
    Array.from(state.rendered).filter((page) => {
      if (!inBand.has(page)) return false;
      if (!shouldBuildTextLayer(page, state.textLayerPending, state.textLayerRendered, state.textLayerFailed)) {
        return false;
      }
      const el = pageEls.get(page);
      return !!el && distanceFromViewportCenter(el, viewportCenter) <= threshold;
    }),
  );
  return pagesNearestCenter(eligible, pageEls, viewportCenter, limit);
}

/** The device-pixel-ratio a FULL-quality (sharpened) canvas should render
 *  at — `window.devicePixelRatio` when a `window` exists (guards the same
 *  jsdom/non-browser gap `renderPdfPage`'s pre-existing inline check
 *  already handled), `1` otherwise. Exported so scheduler tests can assert
 *  against the exact resolution `sharpenPdfPage` targets without
 *  duplicating this `window` guard. Pure query. */
export function fullOutputScale(): number {
  return typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
}

/** True when the DRAFT raster (`DRAFT_OUTPUT_SCALE`) is ALREADY full
 *  quality for this runtime — i.e. `fullOutputScale() <= DRAFT_OUTPUT_SCALE`
 *  (non-Retina, `devicePixelRatio` 1). `renderPdfPage` marks a page
 *  `fullQuality` immediately when this is true, so it never becomes a
 *  `sharpenCandidates` hit — sharpening would re-render pixel-identical
 *  output for zero visible gain (team-lead spec: "devicePixelRatio가 1이면
 *  선명화 자체를 건너뛴다"). Pure query. */
export function draftIsFullQuality(): boolean {
  return fullOutputScale() <= DRAFT_OUTPUT_SCALE;
}

/** Whether `page` still deserves a sharpen pass — false once it's already
 *  `fullQuality`, a sharpen for it is already `sharpenPending`, or it
 *  `sharpenFailed` terminally (mirrors `shouldRenderPage`/
 *  `shouldBuildTextLayer`'s disjoint-set shape). Pure query. Exported so
 *  tests can assert a page's sharpen eligibility directly instead of
 *  re-deriving it from three separate set memberships. */
export function needsSharpening(state: PageRenderState, page: number): boolean {
  return !state.fullQuality.has(page) && !state.sharpenPending.has(page) && !state.sharpenFailed.has(page);
}

/** Pages `reconcile`'s sharpen step should upgrade next, nearest-viewport-
 *  center first (`pagesNearestCenter`, the SAME ranking canvas/text-layer
 *  scheduling already use), capped at `limit`. Candidates are drawn from
 *  `target` — THIS reconcile call's own render-target set, already bounded
 *  by `MAX_RENDERED_PAGES` — filtered to pages whose DRAFT canvas is
 *  already on screen (`state.rendered`) and that `needsSharpening`. Unlike
 *  `textLayerCandidates`, there's no separate viewport-distance threshold:
 *  sharpening only ever touches a page the reader is already being shown a
 *  canvas for, so `target` itself is already the right boundary — there's
 *  no wider "prefetch band" analog to narrow further. Pure query. */
function sharpenCandidates(
  state: PageRenderState,
  target: ReadonlySet<number>,
  pageEls: ReadonlyMap<number, HTMLElement>,
  viewportCenter: number,
  limit: number,
): number[] {
  const eligible = new Set(
    Array.from(target).filter((page) => state.rendered.has(page) && needsSharpening(state, page)),
  );
  return pagesNearestCenter(eligible, pageEls, viewportCenter, limit);
}

/** The CSS class name of the DOM node `rasterPageCanvas` wraps a page's
 *  `<canvas>` in — a named constant (not a repeated string literal) because
 *  BOTH `rasterPageCanvas` (builds one) and `sharpenPdfPage`
 *  (`el.querySelector`s the existing one to replace it) must agree on the
 *  exact same class, and a typo in either copy would silently break the
 *  no-flicker swap. Matches the CSS rule this file injects
 *  (`ensureStyleInjected`'s `.pdf-viewer-page .pdf-viewer-canvas-wrap`),
 *  which is a template-literal `<style>` block rather than something this
 *  constant can interpolate into without complicating that block for no
 *  functional gain. */
const CANVAS_WRAP_CLASS = "pdf-viewer-canvas-wrap";

/** Stage 1 of the two-stage raster ("초안 → 선명화", 재호출 2026-08-17,
 *  team-lead spec): every page's FIRST canvas renders at this backing-store
 *  resolution regardless of `devicePixelRatio` — 1 device px per CSS px,
 *  the cheapest raster pdf.js can produce for a given fit-width viewport.
 *  On Retina (`devicePixelRatio` 2) this is 1/4 the pixels — and 1/4 the
 *  memory — of the OLD single-pass `outputScale = devicePixelRatio` render
 *  this file used to do unconditionally for EVERY render (see
 *  `MAX_RENDERED_PAGES`'s own ≈19MB/page comment for that math). A cheaper
 *  draft finishes faster, which narrows the window a `.pdf-viewer-page`'s
 *  white placeholder background (`.pdf-viewer-page { background: #fff }`)
 *  sits empty during a fast scroll — 사용자 리포트 (2026-08-17): "갑자기
 *  로드돼서 깜빡이는 현상이 없진 않아", "빠르게 스크롤하면 채워지는 게
 *  간헐적으로 보인다". `sharpenPdfPage` upgrades a draft to
 *  `fullOutputScale()` afterward, once no draft render is competing for the
 *  worker (see `reconcile`'s sharpen step) — see `draftIsFullQuality` for
 *  the non-Retina case where this stage IS already full quality and
 *  sharpening never runs at all. */
export const DRAFT_OUTPUT_SCALE = 1;

/** Raster ONE page's canvas at `outputScale` device pixels per CSS pixel —
 *  the geometry (fit-width scale, viewport, canvas backing-store size vs
 *  CSS size) is IDENTICAL between the DRAFT pass (`renderPdfPage`,
 *  `DRAFT_OUTPUT_SCALE`) and the SHARPEN pass (`sharpenPdfPage`,
 *  `fullOutputScale()`) — only the resolution differs — so this is the ONE
 *  place that math lives rather than two near-duplicate copies free to
 *  drift apart.
 *
 *  Returns a DETACHED `.pdf-viewer-canvas-wrap` (never touches `el` or any
 *  live DOM) so callers decide separately WHEN and HOW to attach it —
 *  `renderPdfPage` always replaces `el`'s children outright (first paint,
 *  nothing to preserve), `sharpenPdfPage` swaps only the existing canvas
 *  wrap in place so a sibling text layer survives (see that function's own
 *  comment on why).
 *
 *  `registerTask` is called synchronously, right after `pdfPage.render()`
 *  returns and BEFORE this function awaits its promise — the same timing
 *  the pre-split `renderPdfPage` had, so a caller's `evictPage` can still
 *  cancel a render that's genuinely mid-flight rather than racing to
 *  register it after the fact. Command (async IO; does not mutate `state` —
 *  the caller does that after this resolves, choosing which sets to update
 *  for its own stage). */
async function rasterPageCanvas(
  pdfPage: PdfPageProxy,
  pagesEl: HTMLElement,
  zoomFactor: number,
  outputScale: number,
  registerTask: (task: { cancel(): void }) => void,
): Promise<{ canvasWrap: HTMLElement; viewport: PdfViewport; scale: number }> {
  const unscaled = pdfPage.getViewport({ scale: 1 });
  const scale = fitWidthScale(unscaled.width, pageTargetWidth(pagesEl), zoomFactor);
  const viewport = pdfPage.getViewport({ scale });

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
  registerTask(renderTask);
  await renderTask.promise;

  const canvasWrap = document.createElement("div");
  canvasWrap.className = CANVAS_WRAP_CLASS;
  canvasWrap.style.width = `${viewport.width}px`;
  canvasWrap.style.height = `${viewport.height}px`;
  canvasWrap.appendChild(canvas);

  return { canvasWrap, viewport, scale };
}

/** Request + swap in one page's rendered CANVAS (or an error message on
 *  failure) — the TEXT layer is now a separate step, see `renderTextLayer`
 *  below.
 *
 *  재호출 (2026-08-17, 사용자 리포트 "스크롤보다 로드가 느려서 한번에 파파박
 *  다급하게 로드되면서 페이지가 급변해"): this function used to build the
 *  text layer inline, in the SAME async chain, before ever swapping the
 *  canvas into `el`. A dense book page's text layer is hundreds of
 *  absolutely-positioned spans built by `TextLayer.render()` on the MAIN
 *  thread — nothing the reader needs to see the page, but something that
 *  delayed the moment a scrolled-to page actually became visible by however
 *  long that DOM construction took. A page counts as "visible" the instant
 *  its canvas lands; `reconcile`'s separate text-layer step
 *  (`textLayerCandidates`) decides afterward, independently, whether THIS
 *  page is close enough to the viewport to deserve a text layer at all.
 *
 *  Guarded by `shouldRenderPage` (redundant with `reconcile`'s own
 *  `shouldRenderPage` filter on its candidates, kept here too so this
 *  function stays safe to call directly — e.g. from a test — without going
 *  through `reconcile` first). Re-entrant by design (a window resize OR a
 *  zoom change calls this again for an already-rendered page after
 *  `evictPage` clears its bookkeeping) — always reads the CURRENT
 *  `pageTargetWidth(pagesEl)` AND the caller-supplied `zoomFactor` at call
 *  time (`shell.zoom.get()`, design §B's per-viewer BEHAVIOR table: PDF is a
 *  "재래스터" viewer, never a CSS transform), so a page rendered mid-resize/
 *  mid-zoom fits the latest panel width and zoom rather than a stale one
 *  captured earlier. `onSettled` fires exactly once, on EITHER outcome
 *  (success or the catch below) — `openPdfViewer` wires it to re-run
 *  `reconcile` so a freed concurrency slot or a newly-terminal page gets
 *  picked up immediately, without waiting on another IntersectionObserver
 *  event. Command (void) — kicks off async IO and mutates `el`/the tracking
 *  sets.
 *
 *  `_pdfjs` is unused now that `TextLayer` construction moved to
 *  `renderTextLayer` — kept in the signature (rather than dropped) so both
 *  functions take the same `(page, el, pdfDoc, pdfjs, state, pagesEl,
 *  zoomFactor, onSettled)` shape and every call site (`openPdfViewer`'s
 *  `runReconcile`, tests/pdf-viewer.test.ts's scheduler tests) can pass the
 *  same argument list to either one without reshuffling.
 *
 *  STAGE 1 OF 2 — DRAFT (재호출, 2026-08-17): this is now the DRAFT pass
 *  only, rastering at `DRAFT_OUTPUT_SCALE` regardless of
 *  `devicePixelRatio` — see that constant's own comment for the full "왜".
 *  `sharpenPdfPage` below is the follow-up stage that upgrades this same
 *  page's canvas to `fullOutputScale()` once no draft is competing for the
 *  worker. The canvas-building math itself (fit-width scale, viewport,
 *  backing-store sizing) is shared with `sharpenPdfPage` via
 *  `rasterPageCanvas` so the two passes can never silently disagree about
 *  what "this page's viewport" means. */
export function renderPdfPage(
  page: number,
  el: HTMLElement,
  pdfDoc: PdfDocumentProxy,
  _pdfjs: PdfjsModule,
  state: PageRenderState,
  pagesEl: HTMLElement,
  zoomFactor: number,
  onSettled: () => void,
): void {
  if (!shouldRenderPage(page, state.pending, state.rendered, state.failed)) return;
  state.pending.add(page);
  (async () => {
    const pdfPage = await pdfDoc.getPage(page);
    const { canvasWrap, viewport, scale } = await rasterPageCanvas(
      pdfPage,
      pagesEl,
      zoomFactor,
      DRAFT_OUTPUT_SCALE,
      (task) => state.renderTasks.set(page, task),
    );

    // `--scale-factor`/`--total-scale-factor` drive pdfjs-dist's own
    // `pdf_viewer.css` (`.textLayer`'s font-size/position calc chain) — set
    // on the page element so they inherit into the text layer child
    // `renderTextLayer` appends later, without needing pdfjs-dist's full
    // `.pdfViewer .page` framework markup. Unaffected by `sharpenPdfPage`
    // later swapping the canvas — `scale` (the FIT-WIDTH scale) is identical
    // between the draft and sharpened rasters, only the backing-store
    // resolution (`outputScale`) differs, so these never need re-setting.
    el.style.setProperty("--scale-factor", String(scale));
    el.style.setProperty("--total-scale-factor", String(scale));
    el.style.aspectRatio = "";
    el.style.width = `${viewport.width}px`;
    el.style.height = `${viewport.height}px`;
    el.replaceChildren(canvasWrap);

    // A non-Retina runtime's draft IS full quality already — mark it so
    // `sharpenCandidates` never picks this page up (see
    // `draftIsFullQuality`'s own comment).
    if (draftIsFullQuality()) state.fullQuality.add(page);

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

/** Re-raster an ALREADY-drafted page's canvas at full `fullOutputScale()`
 *  resolution and swap it in — STAGE 2 OF 2 of the progressive raster (see
 *  `DRAFT_OUTPUT_SCALE`'s comment for the full "왜", `renderPdfPage`'s own
 *  comment for stage 1). Only ever requested for a page whose draft canvas
 *  is already on screen (`sharpenCandidates` reads `state.rendered`), so
 *  this recomputes the SAME fit-width viewport `renderPdfPage` used via the
 *  shared `rasterPageCanvas` helper (mirrors `renderTextLayer`'s own
 *  comment on why recomputing beats caching — a resize/zoom that would make
 *  the two disagree evicts the draft canvas FIRST via
 *  `rerenderVisiblePages`, which clears `state.rendered` and cancels this
 *  task too).
 *
 *  NO-FLICKER SWAP (team-lead spec, "선명화는 화면을 비우면 안 된다"):
 *  `rasterPageCanvas` builds the new canvas wrap OFF-DOM and never touches
 *  `el` while doing it. Only once it's FULLY rendered does this function
 *  find `el`'s EXISTING `.pdf-viewer-canvas-wrap` child and `replaceWith`
 *  the new one — `el`'s OTHER child, the text layer (`renderTextLayer`
 *  appends it as `el`'s SECOND child, a sibling of the canvas wrap, never a
 *  descendant of it), is never touched by this replace, so
 *  selection/search built on it survives the swap untouched. Contrast
 *  `renderPdfPage`'s DRAFT swap, which is allowed to `el.replaceChildren()`
 *  wholesale because there is nothing yet on screen worth preserving.
 *
 *  FAILURE IS SILENT (team-lead spec): a sharpen failure never shows the
 *  reader anything — the draft canvas this page already has stays exactly
 *  as it was; only `state.sharpenFailed` is marked, so the page
 *  permanently stops being a `sharpenCandidates` hit (mirrors canvas
 *  `failed`'s "terminal, never retried" contract, minus the visible-error
 *  UI `renderPdfPage`'s own catch shows — losing supplementary resolution
 *  silently is strictly better than surfacing an error for a page the
 *  reader can already read fine).
 *
 *  Guards against the page having left `state.rendered` (evicted) while
 *  this was in flight, same reasoning and same "cancellation vs genuine
 *  failure" disambiguation as `renderTextLayer`'s own guard (`evictPage`
 *  resets `sharpenFailed` synchronously, so a rejection that arrives AFTER
 *  `rendered` is already false is a cancellation, not a real error).
 *  Command (void) — kicks off async IO and mutates `el`/the tracking sets.
 *  Exported (along with `MAX_CONCURRENT_SHARPEN_RENDERS`/`fullOutputScale`/
 *  `draftIsFullQuality`/`needsSharpening`/`DRAFT_OUTPUT_SCALE` above) so
 *  tests/pdf-viewer.test.ts's scheduler tests can drive the sharpen stage
 *  directly. */
export function sharpenPdfPage(
  page: number,
  el: HTMLElement,
  pdfDoc: PdfDocumentProxy,
  state: PageRenderState,
  pagesEl: HTMLElement,
  zoomFactor: number,
  onSettled: () => void,
): void {
  if (!needsSharpening(state, page)) return;
  state.sharpenPending.add(page);
  (async () => {
    const pdfPage = await pdfDoc.getPage(page);
    const { canvasWrap } = await rasterPageCanvas(
      pdfPage,
      pagesEl,
      zoomFactor,
      fullOutputScale(),
      (task) => state.sharpenTasks.set(page, task),
    );

    if (!state.rendered.has(page)) {
      // Evicted (draft canvas gone) while this sharpen was mid-flight — `el`
      // may already belong to a different page's render by now. Drop the
      // result rather than swapping it into anything. `onSettled` still
      // fires: this attempt held one of `MAX_CONCURRENT_SHARPEN_RENDERS`
      // slots, and `reconcile` is the only thing that hands the freed slot
      // to the next candidate (same shape as `renderTextLayer`'s own
      // eviction guard).
      state.sharpenPending.delete(page);
      onSettled();
      return;
    }
    const oldWrap = el.querySelector(`.${CANVAS_WRAP_CLASS}`);
    if (oldWrap) oldWrap.replaceWith(canvasWrap);
    // No `else` branch needed in the normal case: a page only ever reaches
    // here after its DRAFT swap already put a `.pdf-viewer-canvas-wrap` in
    // `el` (`state.rendered.has(page)` just confirmed it). If it were
    // somehow missing, silently dropping the sharpened canvas is safer than
    // guessing where to insert it.
    state.sharpenPending.delete(page);
    state.fullQuality.add(page);
    onSettled();
  })().catch(() => {
    state.sharpenPending.delete(page);
    // Only a GENUINE failure marks the page — see this function's own
    // "FAILURE IS SILENT" comment above and `renderTextLayer`'s identical
    // cancellation-vs-failure guard for why `state.rendered` is the marker.
    if (state.rendered.has(page)) state.sharpenFailed.add(page);
    onSettled();
  });
}

/** Build ONE page's text layer — split out of `renderPdfPage` (see that
 *  function's comment for the full "왜"). Only ever requested for a page
 *  whose canvas has ALREADY rendered (`textLayerCandidates` reads
 *  `state.rendered`), so this recomputes the SAME fit-width viewport
 *  `renderPdfPage` used (same `pageTargetWidth`/`zoomFactor` inputs, not a
 *  cached one) rather than threading the canvas step's viewport through
 *  `state` — a resize/zoom that would make the two disagree ALSO evicts the
 *  canvas via `rerenderVisiblePages` (which clears this page's `rendered`
 *  membership too), so a stale viewport here can't happen without the
 *  canvas being fully re-earned first.
 *
 *  A text-layer failure does NOT touch the already-visible canvas — unlike
 *  `renderPdfPage`'s catch, which is allowed to blank the whole page element
 *  because canvas and text layer used to be one atomic attempt there. Text
 *  is supplementary (selection/search); losing it silently is strictly
 *  better than wiping a page the reader is currently looking at. Guards
 *  against a page that left `state.rendered` (evicted) while this was
 *  in flight — appending a stray `.textLayer` div onto an element some OTHER
 *  page may already be using would be a worse bug than just not building it.
 *  Command (void) — kicks off async IO and mutates `el`/the tracking sets. */
function renderTextLayer(
  page: number,
  el: HTMLElement,
  pdfDoc: PdfDocumentProxy,
  pdfjs: PdfjsModule,
  state: PageRenderState,
  pagesEl: HTMLElement,
  zoomFactor: number,
  onSettled: () => void,
): void {
  if (!shouldBuildTextLayer(page, state.textLayerPending, state.textLayerRendered, state.textLayerFailed)) return;
  state.textLayerPending.add(page);
  (async () => {
    const pdfPage = await pdfDoc.getPage(page);
    const unscaled = pdfPage.getViewport({ scale: 1 });
    const scale = fitWidthScale(unscaled.width, pageTargetWidth(pagesEl), zoomFactor);
    const viewport = pdfPage.getViewport({ scale });

    const textLayerEl = document.createElement("div");
    textLayerEl.className = "textLayer";
    textLayerEl.style.width = `${viewport.width}px`;
    textLayerEl.style.height = `${viewport.height}px`;

    const textContent = await pdfPage.getTextContent();
    const textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: textLayerEl, viewport });
    state.textLayers.set(page, textLayer);
    await textLayer.render();

    if (!state.rendered.has(page)) {
      // Evicted (canvas gone) while this text layer was mid-flight — `el`
      // may already belong to a different page's render by now. Drop the
      // result rather than appending it anywhere. `onSettled` STILL fires:
      // this attempt held one of `MAX_CONCURRENT_TEXT_LAYERS` slots, and
      // `reconcile` is the only thing that hands the freed slot to the next
      // candidate. Returning without it frees the slot but schedules
      // nothing, so the text-layer chain stalls until some UNRELATED event
      // (a band change, a canvas settle) happens to re-run `reconcile` —
      // and at rest, by definition, none does: the near-viewport pages just
      // silently never become selectable.
      state.textLayerPending.delete(page);
      onSettled();
      return;
    }
    el.appendChild(textLayerEl);
    state.textLayerPending.delete(page);
    state.textLayerRendered.add(page);
    onSettled();
  })().catch(() => {
    state.textLayerPending.delete(page);
    // Only a GENUINE failure marks the page. An eviction also lands here:
    // `evictPage` calls `state.textLayers.get(page)?.cancel()`, which
    // rejects the `textLayer.render()` above — and that rejection is
    // delivered asynchronously, i.e. AFTER `evictPage` synchronously ran
    // its own `textLayerFailed.delete(page)`. Marking unconditionally would
    // therefore re-add the flag right after the reset that exists to clear
    // it, and `shouldBuildTextLayer` would then refuse to rebuild the text
    // layer for the page's NEXT canvas render — the exact opposite of what
    // `evictPage`'s comment promises ("a full re-earn deserves a fresh
    // try"). `rendered` is deleted first by `evictPage`, so its absence is
    // the marker that this rejection is a cancellation, not a real error.
    // (Narrow residual: if the page were evicted AND fully re-rendered
    // before this rejection arrives, `rendered` is true again and a stale
    // cancellation would mark a live render as failed — that costs one
    // page's text layer until its next eviction, never a wrong pixel.)
    if (state.rendered.has(page)) state.textLayerFailed.add(page);
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
    textLayerPending: new Set(),
    textLayerRendered: new Set(),
    textLayerFailed: new Set(),
    textLayers: new Map(),
    fullQuality: new Set(),
    sharpenPending: new Set(),
    sharpenFailed: new Set(),
    sharpenTasks: new Map(),
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
    for (const task of rawState.sharpenTasks.values()) task.cancel();
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
    // Read page 1's real aspect ratio BEFORE building any placeholder — see
    // `documentPageAspect`'s own comment for why (실측: A4's hardcoded guess
    // was off by 1.85% on a real book, growing every page at canvas-swap
    // time and pushing the rest of the column down mid-scroll).
    const pageAspect = await documentPageAspect(doc);

    const placeholders = Array.from({ length: doc.numPages }, (_, i) => pagePlaceholder(i + 1, pageAspect));
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
      reconcile(
        rawState,
        inBand,
        pageEls,
        viewportCenterOf(content),
        (page, el) => renderPdfPage(page, el, doc, pdfjs, rawState, content, shell.zoom.get(), runReconcile),
        {
          // `content`'s own on-screen height — the panel-height half of
          // `TEXT_LAYER_DISTANCE_FRACTION`'s "half the panel either side"
          // rule (see `textLayerCandidates`). Read fresh each call, same as
          // `viewportCenterOf(content)` above — cheap relative to how often
          // this runs (event-driven, not per-frame).
          panelHeight: content.getBoundingClientRect().height,
          startTextLayer: (page, el) =>
            renderTextLayer(page, el, doc, pdfjs, rawState, content, shell.zoom.get(), runReconcile),
        },
        {
          // No `pdfjs` needed here (unlike text layer) — sharpening only
          // ever re-rasters a canvas, never touches `TextLayer`.
          startSharpen: (page, el) => sharpenPdfPage(page, el, doc, rawState, content, shell.zoom.get(), runReconcile),
        },
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
