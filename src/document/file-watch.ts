// fs-watch wiring: subscribe to the backend's "file-changed" event and ask the
// backend to watch (or stop watching) the currently open file. The backend
// (notify crate) watches exactly ONE path — a single slot — so opening a new
// file replaces the watch via watch_file(newPath); teardown calls unwatchFile().
//
// The branch decision (auto-reload vs conflict modal) lives in a named pure
// function so main.ts never hides that domain rule in an inline `if`.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isRemoteVault } from "./document-vault";
import type { Vault } from "../workspace/workspace-state";

/** The payload the backend emits on a real external change (self-writes are
 *  filtered out in Rust, so the frontend never sees its own autosave here). */
export interface FileChange {
  readonly path: string;
  readonly generation: string;
  readonly text: string;
  readonly mtime: number;
}

export interface FileUnavailable {
  readonly path: string;
  readonly generation: string;
  readonly kind: "deleted" | "unreadable";
  readonly detail: string;
}

export interface WatchSession {
  readonly path: string;
  readonly generation: string;
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
 *  watch) and return its immutable backend-assigned identity. */
export function watchFile(path: string): Promise<WatchSession> {
  return invoke<WatchSession>("watch_file", { path });
}

/** Stop watching the current file (called on teardown before a re-mount). */
export function unwatchFile(): Promise<void> {
  return invoke<void>("unwatch_file", {});
}

export type WatcherFailurePhase = "detach" | "attach" | "rollback";

export interface WatcherHandoffPort {
  readonly watch: (path: string) => Promise<WatchSession>;
  readonly unwatch: () => Promise<void>;
}

/** Whether `vault`'s currently open document should register a filesystem
 *  watch at all. Local vaults (permanent/global/undefined — no vault yet
 *  known) always should; a remote vault's document lives on ANOTHER
 *  machine — its path (`watch_file`'s argument) is vault-relative
 *  (`"노트.md"`), and the real backend's `notify::Watcher::watch` resolves a
 *  relative path against THIS machine's process CWD, not the host. Watching
 *  it here either fails outright (Finder-launched .app, CWD `/`) or —worse—
 *  silently attaches to an unrelated same-named local file (CWD happens to
 *  hold a `노트.md` of its own), whose edits then overwrite the remote
 *  buffer via the normal external-change reload path. Final review C2: the
 *  remote skip used to live as a per-call-site `if` at each of main.ts's
 *  three open paths (and one of the three never even had it) — this is the
 *  single gate `handoff` itself applies below, so a caller can no longer
 *  forget to check. */
export function shouldWatchDocument(vault: Vault | undefined): boolean {
  return !isRemoteVault(vault);
}

export interface WatcherHandoff {
  handoff(path: string | undefined, vault?: Vault): Promise<boolean>;
  invalidate(): void;
  accepts(event: Pick<WatchSession, "path" | "generation">, currentPath: string): boolean;
}

export function createWatcherHandoff(
  port: WatcherHandoffPort,
  onFailure: (phase: WatcherFailurePhase, error: unknown) => void,
): WatcherHandoff {
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  let activeSession: WatchSession | undefined;

  const handoff = (rawPath: string | undefined, vault?: Vault): Promise<boolean> => {
    // shouldWatchDocument's gate applies HERE, before the path is ever
    // touched, not as a condition each caller has to remember at its own
    // call site — see the doc comment above.
    const path = shouldWatchDocument(vault) ? rawPath : undefined;
    const request = ++generation;
    const result = queue.then(async () => {
      if (request !== generation) return false;
      const previous = activeSession;
      try {
        await port.unwatch();
      } catch (error: unknown) {
        onFailure("detach", error);
        return false;
      }
      if (request !== generation) return false;
      if (!path) {
        activeSession = undefined;
        return true;
      }
      try {
        const session = await port.watch(path);
        if (request !== generation) {
          if (!previous) return false;
          try {
            activeSession = await port.watch(previous.path);
          } catch (rollbackError: unknown) {
            onFailure("rollback", rollbackError);
            activeSession = undefined;
          }
          return false;
        }
        activeSession = session;
        return true;
      } catch (error: unknown) {
        onFailure("attach", error);
        if (!previous) return false;
        try {
          activeSession = await port.watch(previous.path);
        } catch (rollbackError: unknown) {
          onFailure("rollback", rollbackError);
          activeSession = undefined;
        }
        return false;
      }
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    handoff,
    invalidate: () => { generation += 1; },
    accepts: (event, currentPath) =>
      currentPath === event.path
      && activeSession?.path === event.path
      && activeSession.generation === event.generation,
  };
}

/** Subscribe to the backend's external-change event. Returns the Tauri unlisten
 *  fn so the caller can detach. Installed ONCE at boot; the callback reads the
 *  live `current` editor, so it survives re-mounts without re-subscribing. */
export function onFileChanged(cb: (change: FileChange) => void): Promise<UnlistenFn> {
  return listen<FileChange>("file-changed", (event) => cb(event.payload));
}

export function onFileUnavailable(cb: (change: FileUnavailable) => void): Promise<UnlistenFn> {
  return listen<FileUnavailable>("file-unavailable", (event) => cb(event.payload));
}
