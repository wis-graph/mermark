// The HWP/HWPX viewer — a BUILT-IN viewer (_workspace/01_hwp_viewer.md §5),
// not an extension: it needs 3 new Tauri commands (hwp_open/hwp_render_page/
// hwp_close), and R11's extension contract is "frontend only, zero new IPC"
// (design §5 — a facade API that let an extension render arbitrary files via
// the backend was explicitly rejected there). It registers through the SAME
// `registerViewer` the image viewer and every extension use, so opening a
// non-markdown file has exactly one dispatch path regardless of built-in vs.
// extension (main.ts's viewerForEntry/openWithViewer — unchanged).
//
// THE SECURITY CONTRACT THIS VIEWER MAKES (design §4.1 — read before touching
// renderOnePage below): a rendered page enters the DOM ONLY as
// `<img src="data:image/svg+xml;base64,...">`, NEVER as an inline `<svg>`
// node. This is a STRONGER guarantee than sandboxing or sanitizing — SVG-as-
// image is a browser-engine-level mode that never executes script, never
// loads external resources, and never runs interaction handlers, by spec,
// regardless of what the SVG source itself contains (rhwp's own
// `escape_xml` could have a bug and this contract still holds). If a future
// change ever appends raw SVG markup into `.hwp-viewer-page` via
// `innerHTML`/`insertAdjacentHTML`, that is a SECURITY REGRESSION —
// tests/hwp-viewer.test.ts's T1 exists specifically to turn red the moment
// that happens.
//
// LAZY RENDER (design §4.2): `hwp_open` returns only a page COUNT. Every
// page starts as an empty placeholder div; an IntersectionObserver requests
// `hwp_render_page(n)` only for placeholders near the viewport. Rendered
// pages are never evicted (MVP — see design §4.2/§6 for the accepted
// tradeoff). Pages already rendered or already in flight are never
// re-requested (`shouldRenderPage` below) — the observer can fire more than
// once for the same element (scroll jitter, re-entering rootMargin).
import { invoke } from "@tauri-apps/api/core";
import { registerViewer, type Viewer, type ViewerHandle } from "./registry";
import { openViewerShell } from "./shell";
import { pagePlaceholder, svgToDataUrl, pageAspectFrom, isNearViewport } from "./hwp-pages";

/** jsdom-only fallback baseline (px) for `pageBaseWidth` below — jsdom never
 *  runs real layout, so `clientWidth` is always 0 there and this constant is
 *  the only width `applyHwpPageWidth` can use in a vitest environment. In a real
 *  browser this number is never read (04_audit_report.md 재호출: a fixed
 *  600px baseline was the reason a 4K panel — now `92vw` wide, styles.css —
 *  still rasterized pages at a 595px-equivalent original size; the panel
 *  grew but the pages inside it didn't). */
const HWP_PAGE_FALLBACK_WIDTH = 600;

/** The fraction of the pages column ONE page occupies — a reading column
 *  narrower than the full panel, kept in lockstep with the PDF viewer's
 *  `PDF_PAGE_WIDTH_FRACTION` (pdf-viewer/index.ts) so the two document viewers
 *  render pages at the SAME width. At 100% a portrait A4 page (aspect ~0.69)
 *  rendered ~1.45× the panel width TALL — far past the `88vh` envelope — so you
 *  had to zoom OUT to see a single page (사용자 리포트 2026-07-18: "축소를 해야
 *  전체가 보인다"). 0.9 leaves a modest reading margin on both sides while still
 *  filling most of the panel (사용자 지정 2026-07-18: "hwp 는 90%"). Change this
 *  and `PDF_PAGE_WIDTH_FRACTION` together — they are one design decision. */
const HWP_PAGE_WIDTH_FRACTION = 0.9;

/** The page's fit-to-panel width (px) — `HWP_PAGE_WIDTH_FRACTION` of the page
 *  column's ACTUAL rendered width, so pages fill a reading column proportional
 *  to however big `.hwp-viewer`'s `92vw` envelope (styles.css) currently is on
 *  this screen (PDF-parity), rather than the FULL panel width (which overflowed
 *  the viewport) or a constant blind to viewport size. NOT multiplied by the
 *  editor's fontScale — the fit is independent of body-text zoom. Reading
 *  `clientWidth` forces a synchronous layout, which is fine here — it's called
 *  only on open and on window resize, never per-frame. Pure query. */
function pageBaseWidth(pagesEl: HTMLElement): number {
  return (pagesEl.clientWidth || HWP_PAGE_FALLBACK_WIDTH) * HWP_PAGE_WIDTH_FRACTION;
}

/** Set every page's fit-to-panel width via one CSS custom property on the
 *  scroll container (`.hwp-viewer-page`'s `width` reads `var(--hwp-page-width)`,
 *  styles.css) — so a page added AFTER this call (a placeholder that hasn't
 *  rendered yet) still inherits the right width with no extra bookkeeping.
 *  `factor` is the SHELL's viewer-local zoom (`shell.zoom.get()` at call
 *  time, design §B's per-viewer BEHAVIOR table — "재래스터 불필요": a page is
 *  an `<img src="data:image/svg+xml">` (vector), so scaling its CSS width
 *  alone stays crisp at any factor, unlike PDF's raster canvas). Still
 *  INDEPENDENT of the editor's body-text zoom (fontScale) — a document
 *  viewer should show the whole page, not inherit "cmd +/-" and render past
 *  the panel edge (사용자 리포트 2026-07-18: "본문보다 2배 커보여, 컨텐츠가 다
 *  안 보임") — that decoupling is unchanged by adding `factor`; the two axes
 *  stay orthogonal (v0.8.6, preserved). Command (void) — a DOM mutation. */
function applyHwpPageWidth(pagesEl: HTMLElement, factor: number): void {
  pagesEl.style.setProperty("--hwp-page-width", `${pageBaseWidth(pagesEl) * factor}px`);
}

/** The page index a placeholder (or its rendered replacement) belongs to —
 *  the single place `data-page` is read back, so the observer callback and
 *  any future caller agree on the parse (`pagePlaceholder`, hwp-pages.ts, is
 *  the single place it's WRITTEN). Pure query. */
function pageIndexOf(el: HTMLElement): number {
  return Number(el.dataset.page ?? "-1");
}

/** "Should a render request go out for this page right now" — false when the
 *  page already has a rendered `<img>`/error OR a request is already in
 *  flight, so scroll jitter re-firing the observer on the same placeholder
 *  never double-requests it (design §4.2's "in-flight 가드"). Pure query. */
function shouldRenderPage(page: number, pending: ReadonlySet<number>, rendered: ReadonlySet<number>): boolean {
  return !pending.has(page) && !rendered.has(page);
}

/** Wire up lazy rendering: a real `IntersectionObserver` when the runtime has
 *  one, or an eager "render every page immediately" fallback when it
 *  doesn't (jsdom has no `IntersectionObserver` — design §8 F-3: "관측
 *  트리거를 명명 함수로 분리해 테스트에서 직접 호출"; the fallback below is
 *  that separation made concrete — `onVisible` is the SAME function either
 *  path calls, so there is exactly one "what happens when a page becomes
 *  visible" rule regardless of which branch runs). Command (returns a
 *  disconnect handle; the construction/observe calls are the side effect). */
function observePages(
  root: HTMLElement,
  placeholders: readonly HTMLElement[],
  onVisible: (page: number, el: HTMLElement) => void,
): { disconnect(): void } {
  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!isNearViewport(entry)) continue;
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

/** Render ONE HWP page: request its SVG and swap in the `<img>` (or an error
 *  box on failure). The `shouldRenderPage` guard + `pending` reservation are
 *  done by the caller (`enqueueRender` in openHwpViewer) BEFORE this runs, so
 *  this is just the async work the serial render chain awaits. On page 0's
 *  success, applies its real aspect ratio to every not-yet-rendered
 *  placeholder (`applyAspectOnce`) — design §4.2's "첫 페이지 SVG의
 *  width/height 속성을 읽어 전 placeholder 비율을 갱신". Never rejects (a
 *  failure becomes an in-page message), so the render chain always advances to
 *  the next page. */
async function renderOnePage(
  page: number,
  el: HTMLElement,
  pending: Set<number>,
  rendered: Set<number>,
  applyAspectOnce: (svg: string) => void,
): Promise<void> {
  try {
    const svg = await invoke<string>("hwp_render_page", { page });
    pending.delete(page);
    rendered.add(page);
    const img = document.createElement("img");
    img.className = "hwp-viewer-page-img";
    img.alt = `페이지 ${page + 1}`;
    img.src = svgToDataUrl(svg);
    el.replaceChildren(img);
    if (page === 0) applyAspectOnce(svg);
  } catch (err: unknown) {
    pending.delete(page);
    rendered.add(page); // a failed page is terminal — never retried
    el.classList.add("hwp-viewer-page-error");
    el.textContent = `페이지를 불러올 수 없습니다: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Apply `pageAspectFrom(svg)` to every placeholder that hasn't rendered an
 *  `<img>` yet, exactly once (idempotent past the first call) — a closure
 *  factory so `openHwpViewer` doesn't need a module-level flag shared across
 *  concurrently open viewers. Pure-ish: no external state beyond the
 *  `applied` flag closed over here and the `placeholders` DOM it's handed. */
function makeApplyAspectOnce(placeholders: readonly HTMLElement[]): (svg: string) => void {
  let applied = false;
  return (svg: string) => {
    if (applied) return;
    const aspect = pageAspectFrom(svg);
    if (aspect == null) return;
    applied = true;
    for (const ph of placeholders) {
      if (!ph.querySelector("img")) ph.style.aspectRatio = String(aspect);
    }
  };
}

/** Open `absPath` in the HWP viewer: shell up immediately with a loading
 *  status, `hwp_open` in the background, then swap in the placeholder grid
 *  (or an error status) once the page count is known. Mirrors excel/html
 *  viewer's openXxxViewer shape (design §7 step 4/F-3). Command. */
function openHwpViewer(absPath: string): ViewerHandle {
  const content = document.createElement("div");
  content.className = "hwp-viewer-status";
  content.textContent = "문서 불러오는 중…";

  const shell = openViewerShell({ absPath, paneClass: "hwp-viewer", content });

  // Shell-owned viewer-local zoom (design §B) — a plain closed-over variable,
  // not a second SSOT: `shell.zoom` is the single source, this just caches
  // its CURRENT value so the resize handler (which fires independent of any
  // zoom change) can re-apply the latest factor instead of silently
  // resetting to 1 on every window resize.
  let zoomFactor = shell.zoom.get();
  const unsubscribeZoom = shell.zoom.bind((factor) => {
    zoomFactor = factor;
    if (content.classList.contains("hwp-viewer-pages")) applyHwpPageWidth(content, zoomFactor);
  });
  shell.onTeardown(unsubscribeZoom);

  let observerHandle: { disconnect(): void } | null = null;
  // The panel is now `.viewer-panel`'s flex:1 (full-pane rewrite), so the
  // page column's own width — and therefore pageBaseWidth() — changes on
  // window resize. Re-apply on resize so a page already open when the OS
  // window/display changes refits instead of staying stuck at its
  // first-rendered width. `typeof window` guard mirrors observePages'
  // IntersectionObserver feature-check for the same jsdom-has-no-real-layout
  // reason. (Still independent of the editor's fontScale — only the SHELL's
  // own zoomFactor and the panel's rendered width feed this.)
  const onResize = () => {
    if (content.classList.contains("hwp-viewer-pages")) applyHwpPageWidth(content, zoomFactor);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("resize", onResize);
    shell.onTeardown(() => window.removeEventListener("resize", onResize));
  }
  shell.onTeardown(() => observerHandle?.disconnect());
  shell.onTeardown(() => {
    invoke("hwp_close").catch(() => {
      // best-effort — the session is server-side state; a failed close here
      // means at worst a stale slot the NEXT hwp_open silently replaces.
    });
  });

  (async () => {
    const info = await invoke<{ pages: number }>("hwp_open", { path: absPath });

    const pending = new Set<number>();
    const rendered = new Set<number>();
    const placeholders = Array.from({ length: info.pages }, (_, i) => pagePlaceholder(i));
    const applyAspectOnce = makeApplyAspectOnce(placeholders);

    content.className = "hwp-viewer-pages";
    content.replaceChildren(...placeholders);
    applyHwpPageWidth(content, zoomFactor);

    // Serialize hwp_render_page to one-in-flight. hwp.rs keeps the single
    // parsed document in a one-slot mutex that hwp_render_page TAKES OUT for
    // the whole render, so two concurrent renders race — the second finds an
    // empty slot and fails "HWP 세션이 없습니다" (사용자 리포트 2026-07-18:
    // 여러 페이지 중 일부만 렌더되고 나머지는 세션 없음 에러). The lazy
    // observer fires for several near-viewport pages at once, so we chain them
    // through one promise. `shouldRenderPage` + `pending.add` run SYNCHRONOUSLY
    // here (not inside renderOnePage) so a repeat observer fire for a page
    // already queued is dropped before it can enqueue a duplicate.
    let renderChain: Promise<unknown> = Promise.resolve();
    const enqueueRender = (page: number, el: HTMLElement): void => {
      if (!shouldRenderPage(page, pending, rendered)) return;
      pending.add(page);
      renderChain = renderChain.then(() => renderOnePage(page, el, pending, rendered, applyAspectOnce));
    };
    observerHandle = observePages(content, placeholders, enqueueRender);
  })().catch((err: unknown) => {
    content.replaceChildren();
    content.className = "hwp-viewer-status";
    content.textContent = `문서를 열 수 없습니다: ${err instanceof Error ? err.message : String(err)}`;
  });

  return { close: () => shell.close() };
}

const HWP_VIEWER: Viewer = {
  id: "hwp",
  extensions: ["hwp", "hwpx"],
  label: "HWP 문서",
  open: openHwpViewer,
};

/** Register the HWP viewer. Called once from main.ts's boot registration
 *  block, alongside the built-in image viewer (design §5) —
 *  `registerViewer`'s own duplicate-id guard makes a second call a developer
 *  error, matching every other registry in this codebase. Command (void). */
export function registerHwpViewer(): void {
  registerViewer(HWP_VIEWER);
}
