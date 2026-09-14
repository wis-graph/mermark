// One-time migration: recentDocsSetting used to store a flat string[] of
// paths with no vault identity (Task 11 fix round 3's finding — see
// recent-docs.ts's RecentEntry doc comment for the bug this caused). Every
// pre-migration entry is guaranteed LOCAL (recents only started accepting
// remote documents once RecentEntry/vaultId existed), so each one is
// attached to the local vault that owns it and re-saved in the new shape.
//
// Unlike favorite-vault-migration.ts, this needs no separate "migration
// completed" state key: the lookup below (`readLegacyRecentDocPaths`) only
// ever returns entries that are STILL plain strings in the raw stored JSON.
// Once migration writes the new {path, vaultId} shape back through
// `recentDocsSetting`, every future read of the same key sees objects, not
// strings, so the legacy reader naturally returns [] from then on — the
// migration is idempotent by construction, not by tracked state. This is
// also why it's safe to run unconditionally at every boot (cheap: a no-op
// once already migrated) rather than gating it behind a one-shot flag the
// way the async, side-effecting favorite-folder migration needs to.
import type { WorkspaceStore } from "../../workspace/workspace-state";
import { canonicalRootPath } from "../../workspace/workspace-state";
import { permanentVaultForPath } from "../../workspace/cli-routing";
import type { RecentEntry } from "./recent-docs";

export const recentDocsStorageKey = "mermark.recentDocs";

/** Read the OLD recentDocsSetting shape (a flat string[]) directly from
 *  localStorage, bypassing recentDocsSetting's own `parse` — which only
 *  accepts the NEW {path,vaultId} object shape and would silently drop a
 *  legacy string element as malformed. Returns [] both when there is
 *  nothing stored AND once migration has already run (see the module
 *  header). Pure query. */
export const readLegacyRecentDocPaths = (): readonly string[] => {
  const raw = localStorage.getItem(recentDocsStorageKey);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
};

/** Attach each legacy recent path to the LOCAL vault that owns it.
 *  `permanentVaultForPath` (not `routeCliFile`/`routeCanonicalPath`) is
 *  deliberate: those SELECT the resolved vault as a side effect (correct
 *  when the caller is actually opening that one file — CLI launch, the
 *  open-path prompt — wrong here, where up to `RECENT_CAP` entries the user
 *  is NOT opening would each flip the workspace's current-vault selection
 *  as a side effect of merely migrating a list). A path under no registered
 *  permanent vault's root falls back to the Global Vault, exactly like a
 *  CLI open of that same path would (`routeCliFile`'s own fallback). Pure
 *  query. */
export const migrateLegacyRecentPaths = (store: WorkspaceStore, legacyPaths: readonly string[]): RecentEntry[] =>
  legacyPaths.map((path) => {
    const permanent = permanentVaultForPath(store.get(), canonicalRootPath(path));
    return { path, vaultId: permanent ? permanent.vaultId : store.getGlobalVault().vaultId };
  });
