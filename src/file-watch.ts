// fs-watch wiring: subscribe to the backend's "file-changed" event and ask the
// backend to watch (or stop watching) the currently open file. The backend
// (notify crate) watches exactly ONE path — a single slot — so opening a new
// file replaces the watch via watch_file(newPath); teardown calls unwatchFile().
//
// The branch decision (auto-reload vs conflict modal) lives in a named pure
// function so main.ts never hides that domain rule in an inline `if`.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** The payload the backend emits on a real external change (self-writes are
 *  filtered out in Rust, so the frontend never sees its own autosave here). */
export interface FileChange {
  text: string;
  mtime: number;
}

export type ExternalChangeAction = "reload" | "conflict";

/** The auto-reload-vs-conflict rule in ONE named place: if the local buffer has
 *  no unsaved work, the disk version is safe to adopt silently (`reload`);
 *  otherwise the two have diverged and the user must choose (`conflict`). Pure
 *  (CQS query) so main.ts dispatches by intent, not by an inline ternary. */
export function decideExternalChange(hasUnsaved: boolean): ExternalChangeAction {
  return hasUnsaved ? "conflict" : "reload";
}

/** Begin watching `path` for external changes (single slot: replaces any prior
 *  watch). Command/CQS: void-ish (the invoke promise is awaited by callers that
 *  care; failures are non-fatal — the editor still works without a watcher). */
export function watchFile(path: string): Promise<void> {
  return invoke<void>("watch_file", { path });
}

/** Stop watching the current file (called on teardown before a re-mount). */
export function unwatchFile(): Promise<void> {
  return invoke<void>("unwatch_file", {});
}

/** Subscribe to the backend's external-change event. Returns the Tauri unlisten
 *  fn so the caller can detach. Installed ONCE at boot; the callback reads the
 *  live `current` editor, so it survives re-mounts without re-subscribing. */
export function onFileChanged(cb: (change: FileChange) => void): Promise<UnlistenFn> {
  return listen<FileChange>("file-changed", (event) => cb(event.payload));
}
