// Shared clipboard-write helper. Every write goes through the backend IPC
// command `copy_to_clipboard`, never `navigator.clipboard` — see design
// rationale in _workspace/01_copypath_design.md branch 5. WKWebView's
// custom-scheme origin in the shipped app blocks/omits the web clipboard API
// in ways http-origin dev/golden environments never exercise
// (wkwebview-custom-scheme-test-gap memory), so the web API can't satisfy the
// reliability requirement. This is the single write path for every caller
// (path.copy, bundle.copy) — no web fallback, so success/failure is never
// ambiguous about which path actually wrote.
import { invoke } from "@tauri-apps/api/core";

/** Write `text` to the system clipboard via the backend IPC command. Returns
 *  whether the write succeeded so callers can flash transient feedback.
 *  Never throws — a rejected invoke reports as `false`. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await invoke<void>("copy_to_clipboard", { text });
    return true;
  } catch (err) {
    console.error("Failed to copy text to clipboard", err);
    return false;
  }
}
