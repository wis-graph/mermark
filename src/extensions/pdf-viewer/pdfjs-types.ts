// pdfjs-dist call-surface types moved out of index.ts (2026-09-25, pure move).

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
export interface PdfLoadingTask {
  promise: Promise<PdfDocumentProxy>;
  destroy(): Promise<void>;
}
