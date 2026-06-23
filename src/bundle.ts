// Isolated module: copy the current document's LLM context bundle to the
// clipboard via a global keyboard shortcut. The bundle envelope (root doc +
// 1-hop wikilinked docs, XML-wrapped) is built entirely in Rust — this module
// is an opaque transport: invoke → clipboard → feedback. It never parses or
// reconstructs the envelope (format is the backend's SSOT). No new dep or
// capability: `bundle_doc` is an existing IPC command and the clipboard is the
// webview's web API (no asset/IPC scope involved).
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

/** Does this keydown ask to copy the document bundle? (Cmd/Ctrl-Shift-C).
 *  Named so the modifier rule lives in one place, not an inline `if`. Uses
 *  `e.code === "KeyC"` (physical key) so it fires under non-Latin layouts
 *  (e.g. Korean) the same way the ⌘E toggle does. */
function isCopyBundleChord(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyC";
}

export interface BundleShortcutFeedback {
  /** Called after a copy attempt resolves: `true` = on clipboard, `false` = failed. */
  onResult?: (copied: boolean) => void;
}

/** Install the Cmd/Ctrl-Shift-C "copy bundle" shortcut as its own
 *  capture-phase keydown listener (separate from main.ts's ⌘E / zoom listeners,
 *  same capture pattern). Keeps the chord + invoke + clipboard + feedback
 *  self-contained here so main.ts only adds an import and one call — the
 *  smallest possible footprint on a hot, concurrently-edited file.
 *
 *  `getFile` yields the current document path (or null when none is open);
 *  the shortcut is a no-op with no file. */
export function installBundleShortcut(
  getFile: () => string | null,
  feedback?: BundleShortcutFeedback,
): void {
  window.addEventListener(
    "keydown",
    (e) => {
      if (!isCopyBundleChord(e)) return;
      const file = getFile();
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      void copyBundleToClipboard(file).then((copied) => feedback?.onResult?.(copied));
    },
    { capture: true },
  );
}
