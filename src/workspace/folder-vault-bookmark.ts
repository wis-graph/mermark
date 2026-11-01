import { isRemoteVault } from "../document/document-vault";
import { basename, isLocalAbsolutePath } from "../document/path";
import {
  GLOBAL_VAULT_ID,
  WorkspaceStateError,
  findRemoteVaultByRoot,
  remoteVaultRootFrom,
  type RemoteVault,
  type Vault,
  type WorkspaceStore,
} from "./workspace-state";

/** Where an explorer row's bookmark toggle points — decided ONLY by the kind
 *  of vault being browsed (I2: a remote row is a vault-relative name and must
 *  never reach the local `canonicalize_path`). Pure query. */
export type FolderBookmarkTarget =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "remote"; readonly browsing: RemoteVault; readonly root: string | null };

export function folderBookmarkTargetFor(browsing: Vault | undefined, rowPath: string): FolderBookmarkTarget {
  return browsing && isRemoteVault(browsing)
    ? { kind: "remote", browsing, root: remoteVaultRootFrom(rowPath) }
    : { kind: "local", path: rowPath };
}

/** Toggling the vault the explorer is standing in would leave `currentVault()`
 *  unrouted while remote rows remain (the I2 leak) — never allowed. */
const isBrowsingVaultItself = (existing: Vault | undefined, browsing: Vault): boolean =>
  existing !== undefined && existing.vaultId === browsing.vaultId;

export interface FolderVaultBookmarkDeps {
  readonly store: WorkspaceStore;
  readonly browsingVault: () => Vault | undefined;
  readonly canonicalizeLocal: (path: string) => Promise<string>;
  readonly setRoutedVault: (vault: Vault | undefined) => void;
  readonly reportError: (message: string) => void;
}

export interface FolderVaultBookmarks {
  /** Query. */
  isRegistered(rowPath: string): Promise<boolean>;
  /** Command; the returned promise is only a completion signal. */
  toggle(rowPath: string): Promise<void>;
}

export function createFolderVaultBookmarks(deps: FolderVaultBookmarkDeps): FolderVaultBookmarks {
  const { store, browsingVault, canonicalizeLocal, setRoutedVault, reportError } = deps;

  const report = (error: unknown): void => {
    if (error instanceof WorkspaceStateError || error instanceof Error || typeof error === "string") {
      reportError(error instanceof Error ? error.message : error);
      return;
    }
    throw error;
  };

  /** Registration moves the store selection to the new vault; put it back —
   *  but only onto a vault that still exists (the browsed one may have been
   *  unregistered from the sidebar meanwhile). */
  const restoreSelectionAfterBookmark = (previousId: string | null): void => {
    if (previousId === null) return;
    if (previousId !== GLOBAL_VAULT_ID && !store.get().vaults.some((v) => v.vaultId === previousId)) return;
    store.selectVault(previousId);
  };

  const toggleRemote = (browsing: RemoteVault, root: string | null): void => {
    if (root === null) { reportError("폴더 경로를 볼트로 등록할 수 없습니다"); return; }
    try {
      const existing = findRemoteVaultByRoot(store.get().vaults, browsing.host, browsing.remoteVaultId, root);
      if (isBrowsingVaultItself(existing, browsing)) return;
      if (existing) { store.unregisterVault(existing.vaultId); return; }
      const previousSelectionId = store.get().workspaces[0]?.currentVaultId ?? null;
      store.registerRemoteVault(browsing.host, browsing.remoteVaultId, basename(root), root);
      // Keep the selection where it was: the jump is the sidebar click's job.
      restoreSelectionAfterBookmark(previousSelectionId);
      setRoutedVault(browsing);
    } catch (error) { report(error); }
  };

  const toggleLocal = async (path: string): Promise<void> => {
    if (!isLocalAbsolutePath(path)) return; // I2: a vault-relative row never reaches canonicalize_path
    try {
      const canonical = await canonicalizeLocal(path);
      const existing = store.get().vaults.find((vault) => vault.rootPath === canonical);
      if (existing) {
        const wasCurrent = browsingVault()?.vaultId === existing.vaultId;
        store.unregisterVault(existing.vaultId);
        if (wasCurrent) setRoutedVault(undefined);
      } else {
        const wasGlobal = browsingVault()?.persistenceKind === "global";
        const registered = store.registerCanonicalVault(canonical);
        if (wasGlobal) {
          store.selectVault(GLOBAL_VAULT_ID);
          setRoutedVault(store.getGlobalVault());
        } else {
          setRoutedVault(registered);
        }
      }
    } catch (error) { report(error); }
  };

  return {
    async isRegistered(rowPath) {
      const target = folderBookmarkTargetFor(browsingVault(), rowPath);
      if (target.kind === "remote") {
        return target.root !== null && findRemoteVaultByRoot(store.get().vaults, target.browsing.host, target.browsing.remoteVaultId, target.root) !== undefined;
      }
      if (!isLocalAbsolutePath(target.path)) return false;
      const canonical = await canonicalizeLocal(target.path);
      return store.get().vaults.some((vault) => vault.rootPath === canonical);
    },
    async toggle(rowPath) {
      const target = folderBookmarkTargetFor(browsingVault(), rowPath);
      if (target.kind === "remote") { toggleRemote(target.browsing, target.root); return; }
      await toggleLocal(target.path);
    },
  };
}
