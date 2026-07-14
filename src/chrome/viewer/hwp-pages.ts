// Pure transform layer for the HWP viewer (_workspace/01_hwp_viewer.md §4.3).
// Every function here is a QUERY over a string/DOM value — no invoke, no
// fetch, no IntersectionObserver — so vitest can exercise them directly with
// no editor mount and no Tauri mock involved (same separation-of-concerns
// html-viewer's prepare-html.ts established: pure helpers live outside the
// stateful orchestration file, hwp-viewer.ts owns the invoke/observer glue).

/** Base64-encode `svg` UTF-8-safely and wrap it as a `data:image/svg+xml`
 *  URL — the ONLY way a rendered page ever enters the DOM (design §4.1: an
 *  `<img src="data:...">`, never an inline `<svg>` node, is what keeps a
 *  malicious/corrupt SVG's script content from ever getting an execution
 *  context). Plain `btoa(svg)` would throw/mangle on any non-Latin1
 *  codepoint (Korean text is the overwhelmingly common case for an HWP
 *  document) — encodeURIComponent→unescape is the standard UTF-8-safe btoa
 *  idiom, avoiding a TextEncoder→byte-string round trip that's slower for
 *  strings this size. Pure query. */
export function svgToDataUrl(svg: string): string {
  const base64 = btoa(unescape(encodeURIComponent(svg)));
  return `data:image/svg+xml;base64,${base64}`;
}

/** The declared `width`/`height` attributes of an SVG document's root
 *  element, as a `width / height` aspect ratio — or `null` when either
 *  attribute is missing/non-numeric (design §4.2: "실패 시 null(A4 유지)",
 *  the caller keeps whatever placeholder aspect it already had). Regex over
 *  the raw string (same "good enough, no DOM parser needed" standard
 *  html-viewer's `sniffDeclaredCharset` uses) rather than `DOMParser`, since
 *  an SVG root's width/height are always plain numeric attributes on the
 *  first `<svg ...>` tag — no nesting ambiguity a real parser would resolve
 *  differently. Pure query. */
export function pageAspectFrom(svg: string): number | null {
  const openTag = /<svg\b[^>]*>/.exec(svg)?.[0];
  if (!openTag) return null;
  const width = Number(/\bwidth\s*=\s*["']?([\d.]+)/.exec(openTag)?.[1]);
  const height = Number(/\bheight\s*=\s*["']?([\d.]+)/.exec(openTag)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

/** The "is this placeholder close enough to the viewport to render" rule
 *  (design §4.2's IntersectionObserver predicate) — named so the lazy-render
 *  trigger reads as a domain decision, not a bare `entry.isIntersecting`
 *  inline check scattered across the observer callback. Takes only the one
 *  field it needs so a test can hand it a plain object literal instead of a
 *  real `IntersectionObserverEntry` (which jsdom doesn't construct). Pure
 *  query. */
export function isNearViewport(entry: { isIntersecting: boolean }): boolean {
  return entry.isIntersecting;
}

/** A4 aspect ratio (width / height) — the placeholder's starting shape
 *  before any page has actually rendered and told us its real dimensions
 *  (`pageAspectFrom` above updates it once page 0 lands, design §4.2). */
const DEFAULT_PAGE_ASPECT = 210 / 297;

/** Build one page's placeholder element: the single shape every lazy-render
 *  slot starts as, before `hwp_render_page` fills it with an `<img>` (or an
 *  error message). `data-page` is the one fact the intersection-observer
 *  callback and the render/error swap both need to agree on which page this
 *  element is — kept as a DOM attribute (not a WeakMap or closure) so it
 *  survives being handed to a real `IntersectionObserver`, which only ever
 *  gives back `entry.target` elements. Pure query (constructs and returns;
 *  no side effect beyond building the detached node). */
export function pagePlaceholder(n: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "hwp-viewer-page";
  el.dataset.page = String(n);
  el.style.aspectRatio = String(DEFAULT_PAGE_ASPECT);
  return el;
}
