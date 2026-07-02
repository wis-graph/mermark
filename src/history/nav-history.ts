// Document navigation history — a browser-style linear back/forward stack over
// visited file paths, no storage/DOM. Pure functions that compute the next
// history value, unit-tested without main's boot graph.
//
// This is DISTINCT from the recent-documents list (recent-docs.ts): recent is an
// MRU list (deduped, persisted to localStorage — the SSOT). History is a session
// navigation stack (duplicates ALLOWED — A→B→A is three entries — with a pointer,
// forward-branch truncation, and NO persistence). It is ephemeral in-memory
// state, never a setting, so nothing here touches the settings SSOT.

/** A linear navigation stack (`entries`, in visit order) with a `index` cursor
 *  pointing at the currently-shown entry. Immutable value — every operation
 *  returns a new NavHistory (or the SAME reference to signal a no-op move). */
export interface NavHistory {
  entries: string[];
  index: number;
}

/** How many visited documents to keep. Named constant (not a magic number inline
 *  in pushHistory) so the cap rule lives in one place. */
export const HISTORY_CAP = 50;

/** A fresh history: empty, or seeded with a single first entry at the cursor. */
export function makeHistory(initial?: string): NavHistory {
  return initial === undefined ? { entries: [], index: -1 } : { entries: [initial], index: 0 };
}

/** Navigate to `path`: drop the forward branch (anything after the cursor — a new
 *  navigation abandons the redo path, like a browser), append, advance the cursor
 *  to the new end, then clamp to `cap` (oldest entries fall off the front, with
 *  the index shifted to match). Pure query — most-recent is at the cursor. */
export function pushHistory(h: NavHistory, path: string, cap = HISTORY_CAP): NavHistory {
  const kept = h.entries.slice(0, h.index + 1); // truncate forward branch
  const appended = [...kept, path];
  const overflow = Math.max(0, appended.length - cap);
  const entries = appended.slice(overflow); // drop oldest to fit the cap
  return { entries, index: entries.length - 1 };
}

/** Is there an older entry to go back to? Pure. */
export function canBack(h: NavHistory): boolean {
  return h.index > 0;
}

/** Is there a newer entry to go forward to? Pure. */
export function canForward(h: NavHistory): boolean {
  return h.index < h.entries.length - 1;
}

/** Move the cursor one entry back. Returns the SAME reference when already at the
 *  start (no-op signal the caller checks with `next === h`). Pure. */
export function back(h: NavHistory): NavHistory {
  if (!canBack(h)) return h;
  return { entries: h.entries, index: h.index - 1 };
}

/** Move the cursor one entry forward. Returns the SAME reference when already at
 *  the end (no-op signal). Pure. */
export function forward(h: NavHistory): NavHistory {
  if (!canForward(h)) return h;
  return { entries: h.entries, index: h.index + 1 };
}

/** The path at the cursor, or undefined for an empty history. Pure. */
export function currentEntry(h: NavHistory): string | undefined {
  return h.entries[h.index];
}

/** Remove the entry at `i` (a path that turned out to be gone) and keep the
 *  cursor pointing at a sensible neighbour: entries after the removed one shift
 *  down, so the cursor shifts down too when it sat at or past `i`. Clamped to the
 *  new bounds. Named so the "forget a dead entry" rule isn't an inline splice at
 *  the call site. Pure. */
export function pruneAt(h: NavHistory, i: number): NavHistory {
  if (i < 0 || i >= h.entries.length) return h;
  const entries = [...h.entries.slice(0, i), ...h.entries.slice(i + 1)];
  let index = h.index > i ? h.index - 1 : h.index;
  index = Math.max(0, Math.min(index, entries.length - 1));
  return { entries, index };
}
