// Pure transform layer for the PDF viewer (mirrors hwp-pages.ts's separation:
// no invoke/fetch/DOM here, so vitest exercises this with no editor mount and
// no worker/pdf.js involved at all).

/** The PDF page's fit-to-width render scale — CSS pixels per PDF point,
 *  multiplied by the app's ⌘± zoom on top. A PDF page's UNSCALED viewport
 *  width (pdfjs-dist's `page.getViewport({ scale: 1 }).width`) is expressed
 *  in PDF points (1pt = 1/72in); pdf.js renders 1 point as 1 CSS px at
 *  scale=1, so `containerWidthPx / pageWidthPt` is exactly the scale that
 *  makes the rendered page fill the container's width before the user's own
 *  zoom multiplies on top — same "container clientWidth is the source of
 *  truth" rule hwp-viewer.ts's `pageBaseWidth` established, generalized to a
 *  named pure function per-viewer instead of a viewer-wide constant, since a
 *  PDF's pages are not guaranteed uniform width the way an HWP document's are.
 *  Degenerate inputs (a page or container with zero/negative extent — never
 *  legitimate, but a defensive query should not divide by zero into NaN/Infinity
 *  and propagate a broken CSS width) fall back to the bare zoom factor. Pure
 *  query. */
export function fitWidthScale(pageWidthPt: number, containerWidthPx: number, fontScale: number): number {
  if (!(pageWidthPt > 0) || !(containerWidthPx > 0)) return fontScale;
  return (containerWidthPx / pageWidthPt) * fontScale;
}
