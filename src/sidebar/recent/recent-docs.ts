// Recent-documents list arithmetic — pure functions over an ordered entry
// array, no storage/DOM. The setting (recentDocsSetting) is the SSOT; these
// compute the next list value it should hold. Kept pure so the dedup/cap/
// prune rules are unit-tested without a store or a panel.

/** One recent-document entry: the document's own path (an ABSOLUTE local
 *  path for a permanent/global vault; a VAULT-RELATIVE path like "노트.md"
 *  for a remote vault — remote paths carry no filesystem meaning outside
 *  their own vault) paired with the vault that owns it. Task 11 fix round 3:
 *  a bare `path` alone used to be the whole entry, which had no way to say
 *  WHICH vault a path belongs to — opening a remote recent entry after
 *  switching to a different vault silently read through the wrong backend
 *  (or, for two remote vaults sharing a relative filename, could not even
 *  be told apart). */
export interface RecentEntry {
  readonly path: string;
  readonly vaultId: string;
}

/** How many recent documents to remember. Named constant (not a magic number
 *  inline in pushRecent) so the cap rule lives in one place. */
export const RECENT_CAP = 15;

/** Add `{path, vaultId}` as the most-recent entry: drop any existing entry
 *  with the SAME (path, vaultId) pair (so a re-open moves it to the front
 *  rather than duplicating), prepend it, and clamp to `cap` (oldest fall off
 *  the end). Dedup is keyed on the PAIR, not `path` alone — a local absolute
 *  path is unambiguous on its own, but a remote vault's path is only
 *  relative ("노트.md"), and two different remote vaults can each have one;
 *  deduping by path alone would wrongly conflate them. Most-recent-first.
 *  Pure query. */
export function pushRecent(list: readonly RecentEntry[], entry: RecentEntry, cap = RECENT_CAP): RecentEntry[] {
  const withoutDupe = list.filter((e) => !(e.path === entry.path && e.vaultId === entry.vaultId));
  return [entry, ...withoutDupe].slice(0, cap);
}
