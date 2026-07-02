// Isolated module: copy the current document's LLM context bundle to the
// clipboard. The bundle envelope (root doc + 1-hop wikilinked docs, XML-wrapped)
// is built entirely in Rust — this module is an opaque transport: invoke →
// clipboard. It never parses or reconstructs the envelope (format is the
// backend's SSOT). The keyboard trigger is owned by the global shortcut
// dispatcher (src/shortcuts, action id "bundle.copy"); this module just does the
// copy. No new dep or capability: `bundle_doc` is an existing IPC command and the
// clipboard is the webview's web API (no asset/IPC scope involved).
import { invoke } from "@tauri-apps/api/core";

/** Build the document bundle for `filePath` (Rust SSOT) and put it on the
 *  clipboard. Pure-ish command: returns whether the round-trip succeeded so the
 *  caller can show transient feedback. Swallows both failure modes — a rejected
 *  `bundle_doc` invoke (e.g. root unreadable) and a clipboard write that the
 *  browser/webview refuses — and reports them as `false` instead of throwing,
 *  so a shortcut handler never has to wrap this in its own try/catch. */
export async function copyBundleToClipboard(filePath: string): Promise<boolean> {
  try {
    const xml = await invoke<string>("bundle_doc", { path: filePath });
    await navigator.clipboard.writeText(xml);
    return true;
  } catch (err) {
    console.error("Failed to copy document bundle to clipboard", err);
    return false;
  }
}
