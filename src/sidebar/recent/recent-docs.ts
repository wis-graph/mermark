// Recent-documents list arithmetic — pure functions over an ordered path array,
// no storage/DOM. The setting (recentDocsSetting) is the SSOT; these compute the
// next list value it should hold. Kept pure so the dedup/cap/prune rules are
// unit-tested without a store or a panel.

/** How many recent documents to remember. Named constant (not a magic number
 *  inline in pushRecent) so the cap rule lives in one place. */
export const RECENT_CAP = 15;

/** Add `path` as the most-recent entry: drop any existing occurrence (so a
 *  re-open moves it to the front rather than duplicating), prepend it, and clamp
 *  to `cap` (oldest fall off the end). Most-recent-first. Pure query. */
export function pushRecent(list: string[], path: string, cap = RECENT_CAP): string[] {
  const withoutDupe = list.filter((p) => p !== path);
  return [path, ...withoutDupe].slice(0, cap);
}

/** Remove a path that turned out to be gone (open failed). Named so the
 *  "forget a dead entry" rule isn't an inline filter at the call site. Pure. */
export function pruneMissing(list: string[], missing: string): string[] {
  return list.filter((p) => p !== missing);
}
