// Favorite-folders list arithmetic — pure functions over an ordered path
// array, no storage/DOM. The setting (favoriteFoldersSetting) is the SSOT;
// these compute the next list value it should hold. Kept pure so the
// dedup/order rules are unit-tested without a store or a panel.
//
// This is favorites/recent-docs.ts's TWIN, not a reuse of it — favorites and
// recent are DIFFERENT DOMAINS with opposite rules (intent-review: a domain
// rule gets its own named function, not an inline branch grafted onto the
// other domain's):
//
//   rule              | pushRecent (MRU)          | pushFavorite (curation)
//   ------------------|----------------------------|----------------------------
//   new-item position | prepend (most-recent-first)| append (insertion order kept)
//   duplicate         | dedupe, moved to front     | dedupe, EXISTING position kept
//   cap               | 15 (clamp)                 | none (user curation)
//   auto-prune        | pruneMissing (open failed) | none (never destroy curation)
//   normalization     | none (raw dedupe)          | normalizePath before dedupe
//   reorder           | n/a (order is MRU-derived) | user-explicit only (drag/keyboard,
//                     |                             | never automatic — see reorderFavorite)

import { normalizePath } from "../../document/path";

/** Add `absPath` to the favorites list: normalize it, then, if an equivalent
 *  path (post-normalization) is already present, return the list UNCHANGED
 *  (no reorder — this is curation, not MRU); otherwise append it at the end.
 *  No cap. Pure query. */
export function pushFavorite(list: string[], absPath: string): string[] {
  const p = normalizePath(absPath);
  return list.some((x) => normalizePath(x) === p) ? list : [...list, p];
}

/** Remove every entry whose normalized form matches `absPath`. Manual-only
 *  (never called automatically — a folder that's temporarily unmounted stays
 *  in the list). Pure query. */
export function removeFavorite(list: string[], absPath: string): string[] {
  const p = normalizePath(absPath);
  return list.filter((x) => normalizePath(x) !== p);
}

/** Is `absPath` already a favorite (post-normalization)? Drives the ★-add
 *  button's disabled/pressed state. Pure query (CQS). */
export function isFavorite(list: string[], absPath: string): boolean {
  const p = normalizePath(absPath);
  return list.some((x) => normalizePath(x) === p);
}

/** Move `absPath` to `toIndex` in the list (2026-07-12 design-polish batch ①
 *  — drag/keyboard reorder). Reorder = EXPLICIT USER CURATION ONLY, never an
 *  automatic side effect of add/remove/open (unlike pushRecent's MRU
 *  reshuffling — see the module header contrast table). `toIndex` is clamped
 *  to `[0, list.length - 1]`; an absent path is a no-op (content unchanged);
 *  a same-position move returns the ORIGINAL reference (not just an
 *  equal-content copy) so a caller can cheaply detect "nothing changed"
 *  before committing to the setting. Pure query. */
export function reorderFavorite(list: string[], absPath: string, toIndex: number): string[] {
  const p = normalizePath(absPath);
  const fromIndex = list.findIndex((x) => normalizePath(x) === p);
  if (fromIndex === -1) return list;
  const clamped = Math.min(Math.max(toIndex, 0), list.length - 1);
  if (clamped === fromIndex) return list;
  const next = [...list];
  const [item] = next.splice(fromIndex, 1);
  next.splice(clamped, 0, item);
  return next;
}
