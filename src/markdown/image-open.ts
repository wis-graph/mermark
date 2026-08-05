// Plain-module callback hook (same shape as this codebase's other
// registry-style indirections) that lets ImageWidget (markdown layer) ask
// for the image viewer to open WITHOUT importing the chrome layer directly.
// image-viewer.ts already imports image.ts (resolveImageUrl), so a
// markdown → chrome import here would risk a cycle; main.ts wires the real
// handler once at startup instead.
let handler: ((source: string) => void) | null = null;

/** Wire the real "open this image in the viewer" behavior — called once by
 *  main.ts at startup. Command (void). */
export function setImageOpenHandler(fn: (source: string) => void): void {
  handler = fn;
}

/** Ask whatever handler is wired to open `source` in the image viewer. A
 *  no-op before setImageOpenHandler has run (e.g. a test that never wires
 *  one, or a widget mounted outside the app shell). Command (void). */
export function requestImageOpen(source: string): void {
  handler?.(source);
}
