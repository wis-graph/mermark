// Plain-module callback hook (same shape as image-open.ts — see that file's
// header comment for the cycle this pattern avoids) that lets renderer code
// (WikilinkWidget, the standard-link inline feature) ask for a document to be
// opened in the CURRENT window/tab WITHOUT importing the chrome/app-shell
// layer directly. main.ts wires the real handler once at startup.
//
// Two request shapes, not one, because the two callers arrive at "open this"
// from very different places:
//  - "resolved-document": the caller (WikilinkWidget) has ALREADY resolved an
//    absolute path through its own existence/creation gate — this is just
//    "open it safely in the current window instead of a new one".
//  - "standard-link": the caller (features/link.ts) has only a raw href; the
//    vault-bounded validation pipeline (local-doc-link.ts) and the current
//    document/vault context both live in main.ts's handler closure, not here.
export type DocumentOpenRequest =
  | { readonly kind: "resolved-document"; readonly path: string }
  | { readonly kind: "standard-link"; readonly href: string; readonly feedbackEl: HTMLElement };

let handler: ((request: DocumentOpenRequest) => void) | null = null;

/** Wire the real "open this document in the current window, safely" behavior
 *  — called once by main.ts at startup. Command (void). */
export function setDocumentOpenHandler(fn: (request: DocumentOpenRequest) => void): void {
  handler = fn;
}

/** Ask whatever handler is wired to open `request`. A no-op before
 *  setDocumentOpenHandler has run (e.g. a test that never wires one, or a
 *  widget mounted outside the app shell). Command (void). */
export function requestDocumentOpen(request: DocumentOpenRequest): void {
  handler?.(request);
}
