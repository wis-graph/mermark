// Browser-only mock for @tauri-apps/api/event.
// Injected via Vite alias ONLY in `--mode browser` (see vite.config.ts), the
// same way tauri-core.ts mocks @tauri-apps/api/core. A plain browser has no Rust
// backend and thus no real fs watcher, so we expose window.__mockExternalChange
// as a dev hook that simulates an external edit: it writes the new content into
// the in-memory store (so a later read_file sees it) and fans a "file-changed"
// event out to every registered listener — exactly the shape the real backend
// emits: { text, mtime }.
import { applyMockExternalChange } from "./tauri-core";

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}
export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;

// event name → set of callbacks
const listeners = new Map<string, Set<EventCallback<unknown>>>();
let nextId = 1;

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  const cb = handler as EventCallback<unknown>;
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  fan(event, payload);
}

/** Deliver `payload` to every listener registered for `event`. */
function fan(event: string, payload: unknown): void {
  const set = listeners.get(event);
  if (!set) return;
  const id = nextId++;
  for (const cb of set) cb({ event, id, payload });
}

// Dev hook: simulate an external change to the watched file. Call from the
// DevTools console (or a CDP golden script) — window.__mockExternalChange("...").
// No-op (warns) if nothing is being watched, mirroring the backend which only
// emits for the single watched path.
(window as unknown as { __mockExternalChange?: (text: string) => void }).__mockExternalChange = (
  text: string,
) => {
  const payload = applyMockExternalChange(text);
  if (!payload) {
    console.warn("[mock] __mockExternalChange: no file is being watched");
    return;
  }
  console.info("[mock] __mockExternalChange → file-changed", `${payload.text.length} chars`);
  fan("file-changed", payload);
};
