// Pure transform layer for the PDF viewer (mirrors hwp-pages.ts's separation:
// no invoke/fetch/DOM here, so vitest exercises this with no editor mount and
// no worker/pdf.js involved at all).

/** The PDF page's fit-to-width render scale — CSS pixels per PDF point,
 *  multiplied by the shell's viewer-local zoom on top (full-pane rewrite,
 *  _workspace/01_architect_design.md §B — NOT the app's ⌘±/fontScale, which
 *  a document viewer deliberately ignores; see pdf-viewer/index.ts's
 *  `openPdfViewer`). A PDF page's UNSCALED viewport width (pdfjs-dist's
 *  `page.getViewport({ scale: 1 }).width`) is expressed in PDF points
 *  (1pt = 1/72in); pdf.js renders 1 point as 1 CSS px at scale=1, so
 *  `containerWidthPx / pageWidthPt` is exactly the scale that makes the
 *  rendered page fill the container's width before the viewer's own zoom
 *  multiplies on top — same "container clientWidth is the source of truth"
 *  rule hwp-viewer.ts's `pageBaseWidth` established, generalized to a named
 *  pure function per-viewer instead of a viewer-wide constant, since a PDF's
 *  pages are not guaranteed uniform width the way an HWP document's are.
 *  Degenerate inputs (a page or container with zero/negative extent — never
 *  legitimate, but a defensive query should not divide by zero into NaN/Infinity
 *  and propagate a broken CSS width) fall back to the bare zoom factor.
 *  (Parameter renamed from `fontScale` — post-v0.8.6/full-pane-rewrite, this
 *  input is `shell.zoom.get()`, never the editor's fontScale; the old name
 *  was a lie the naming discipline (mermark-frontend §7) forbids.) Pure
 *  query. */
export function fitWidthScale(pageWidthPt: number, containerWidthPx: number, zoomFactor: number): number {
  if (!(pageWidthPt > 0) || !(containerWidthPx > 0)) return zoomFactor;
  return (containerWidthPx / pageWidthPt) * zoomFactor;
}
