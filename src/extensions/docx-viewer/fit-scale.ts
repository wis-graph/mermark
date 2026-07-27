// Pure transform layer for the docx viewer's fit-to-width scale — mirrors
// pdf-viewer/fit-width-scale.ts's separation (no DOM/invoke here, so vitest
// exercises this with no docx-preview import and no editor mount at all).

/** The fraction of the AVAILABLE (unzoomed) width one docx page is fit to —
 *  kept in lockstep with pdf-viewer/index.ts's `PDF_PAGE_WIDTH_FRACTION` and
 *  hwp-viewer.ts's `HWP_PAGE_WIDTH_FRACTION` (사용자 지정: 세 문서 뷰어 페이지
 *  폭 정책은 하나의 설계 결정 — 바꿀 땐 세 상수를 함께 바꾼다). docx differs from
 *  the other two in HOW it reaches that width: pdf/hwp choose their own render
 *  width directly, but docx-preview lays out each page at its document's
 *  absolute cm-derived px width, so this codebase can only SCALE the already-
 *  rendered page down/up to the same 0.9 fraction rather than render it at
 *  that width to begin with (see docxFitScale below). */
export const DOCX_PAGE_WIDTH_FRACTION = 0.9;

/** The scale factor that fits a docx page (rendered at its native
 *  `pageWidth`, docx-preview's own cm→px conversion) into
 *  `DOCX_PAGE_WIDTH_FRACTION` of `availableWidth` — the SAME "container
 *  clientWidth is the source of truth" rule pdf-viewer's `fitWidthScale` and
 *  hwp-viewer's `pageBaseWidth` already follow, generalized to a pure
 *  function since (unlike pdf/hwp) this scale composes with the viewer's own
 *  CSS `zoom` at the call site rather than driving a re-raster/CSS-var width
 *  directly.
 *
 *  `availableWidth` MUST be read from an ancestor the viewer's own CSS `zoom`
 *  does NOT apply to (openDocxViewer reads `.viewer-panel-body`, `content`'s
 *  parent — `content` itself carries `style.zoom`, and a zoomed element's own
 *  `clientWidth` is reported in zoom-affected units, which would make this
 *  fit computation feed back into itself and oscillate every time zoom
 *  changes — see docx-viewer/index.ts's `refitDocx`).
 *
 *  Degenerate inputs (a page or container with zero/negative/NaN extent —
 *  never legitimate, but a defensive query should not divide by zero into
 *  NaN/Infinity and propagate a broken `zoom` value that blanks the whole
 *  page) fall back to 1 (no additional scaling beyond the user's own zoom).
 *  Pure query. */
export function docxFitScale(availableWidth: number, pageWidth: number): number {
  if (!(availableWidth > 0) || !(pageWidth > 0)) return 1;
  return (availableWidth * DOCX_PAGE_WIDTH_FRACTION) / pageWidth;
}
