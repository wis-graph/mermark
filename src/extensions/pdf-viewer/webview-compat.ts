// WKWebView (production Tauri webview) compatibility shims for pdf.js;
// moved out of index.ts 2026-09-25.

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
export async function makeBlobWorker(scriptUrl: string): Promise<{ worker: Worker; revoke: () => void }> {
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
