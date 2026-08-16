const storageKey = (vaultId: string): string => `mermark.vaultCollapsed.${vaultId}`;

/** Whether a vault's tab strip is collapsed in the workspace sidebar. Persisted
 *  per vaultId, independent of `mermark.vaultTabs.<id>` (VaultTabStore) — this
 *  is UI layout state, not tab data, so it gets its own key rather than
 *  piggybacking on that schema. No stored key means expanded (the default). */
export function isVaultCollapsed(vaultId: string): boolean {
  return localStorage.getItem(storageKey(vaultId)) === "1";
}

/** Persist a vault row's collapse state. Removes the key on expand (the
 *  default) instead of writing "0", so storage only grows for vaults the
 *  user actually collapsed — same economy as VaultTabStore.commit. */
export function setVaultCollapsed(vaultId: string, collapsed: boolean): void {
  if (collapsed) localStorage.setItem(storageKey(vaultId), "1");
  else localStorage.removeItem(storageKey(vaultId));
}
