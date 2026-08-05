import { icon } from "../icons";
import { copyTextToClipboard } from "../clipboard";

// Shared "copy X to clipboard" button, factored out of code-widget.ts so every
// copy-button consumer (code block, blockquote) writes through the single
// backend IPC path (copyTextToClipboard → copy_to_clipboard) — never
// navigator.clipboard, which the shipped app's WKWebView custom-scheme origin
// blocks (wkwebview-custom-scheme-test-gap). A third button added later has no
// web-API path to regress onto: this module is the only place that calls
// copyTextToClipboard for a UI button.

/** How long the button shows its result glyph (check on success, an error
 *  title on failure) before reverting to the idle copy icon/label. Named so
 *  the success and failure paths can't drift out of sync (intent-review). */
export const COPY_FEEDBACK_MS = 1500;

/** Swap the button's icon + title to reflect `ok`, then restore the idle
 *  `idleLabel` after COPY_FEEDBACK_MS. Shared by the success and failure
 *  paths so the timing/DOM-swap rule lives in one place. */
function showCopyFeedback(btn: HTMLButtonElement, idleLabel: string, ok: boolean): void {
  btn.replaceChildren(icon(ok ? "check" : "copy"));
  btn.title = ok ? idleLabel : "복사 실패";
  setTimeout(() => {
    btn.replaceChildren(icon("copy"));
    btn.title = idleLabel;
  }, COPY_FEEDBACK_MS);
}

/** Build a copy-to-clipboard button that writes `text` via the backend IPC
 *  path. `label` is both the idle title/aria-label and the success title
 *  (the action name, e.g. "코드 복사"); `extraClass` names the host-specific
 *  hover/placement rule (e.g. "cm-codeblock-copy", "cm-quote-copy") and is
 *  combined with the shared `cm-copy-btn` base class.
 *
 *  Absolutely positioned by CSS — the caller's host element must be the
 *  `position: relative` anchor, so this never affects the host's layout box.
 *  Its own mousedown/click are stopped from bubbling so a click can't move
 *  the caret or start a text selection; pair with `ignoreEvent` (widget
 *  layer) checking `.cm-copy-btn` so CM leaves events targeting it alone. */
export function createCopyButton(text: string, label: string, extraClass: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `cm-copy-btn ${extraClass}`;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.appendChild(icon("copy"));
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void copyTextToClipboard(text).then((ok) => showCopyFeedback(btn, label, ok));
  });
  return btn;
}
