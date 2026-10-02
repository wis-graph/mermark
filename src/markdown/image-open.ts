// Plain-module callback hook (same shape as this codebase's other
// registry-style indirections) that lets ImageWidget (markdown layer) ask
// for the image viewer to open WITHOUT importing the chrome layer directly.
// image-viewer.ts already imports image.ts (resolveImageUrl), so a
// markdown → chrome import here would risk a cycle; main.ts wires the real
// handler once at startup instead.
import type { Vault } from "../workspace/workspace-state";

let handler: ((source: string, vault: Vault | undefined) => void) | null = null;

/** Wire the real "open this image in the viewer" behavior — called once by
 *  main.ts at startup. Command (void). */
export function setImageOpenHandler(fn: (source: string, vault: Vault | undefined) => void): void {
  handler = fn;
}

/** Ask whatever handler is wired to open `source` in the image viewer.
 *  `vault` is the CLICKED DOCUMENT's own vault (documentVault facet) — never
 *  the sidebar's selection — so a remote document's vault-relative path can't
 *  leak into a local open (design §3.3). A
 *  no-op before setImageOpenHandler has run (e.g. a test that never wires
 *  one, or a widget mounted outside the app shell). Command (void). */
export function requestImageOpen(source: string, vault: Vault | undefined): void {
  handler?.(source, vault);
}
