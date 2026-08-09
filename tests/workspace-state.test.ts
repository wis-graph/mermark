import { beforeEach, describe, expect, it } from "vitest";
import { WorkspaceStateError, WorkspaceStore, canonicalRootPath, workspaceStorageKey } from "../src/workspace/workspace-state";

describe("WorkspaceStore", () => {
  beforeEach(() => localStorage.clear());

  it("registers canonical permanent vaults and rejects aliases", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/./project/", "Project");
    expect(vault.rootPath).toBe(canonicalRootPath("/notes/project"));
    expect(() => store.registerVault("/notes/project")).toThrowError(WorkspaceStateError);
    expect(store.get().workspaces[0]?.vaultIds).toEqual([vault.vaultId]);
    expect(vault.explorerRoot).toBe(vault.rootPath);
  });

  it("creates a session-only temporary vault without persisting it", () => {
    const store = new WorkspaceStore();
    const vault = store.createTemporaryVault("/scratch/./session");

    expect(vault.persistenceKind).toBe("temporary");
    expect(vault.rootPath).toBe("/scratch/session");
    expect(vault.explorerRoot).toBeNull();
    expect(store.get().workspaces[0]?.vaultIds).toEqual([]);
    expect(store.get().sessionTemporaryVaults.map((item) => item.vaultId)).toEqual([vault.vaultId]);
    expect(localStorage.getItem(workspaceStorageKey)).toBeNull();
  });

  it("does not persist a temporary vault as the current vault", () => {
    const store = new WorkspaceStore();
    const permanent = store.registerVault("/notes", "Notes");
    const temporary = store.createTemporaryVault("/scratch/session");
    store.selectVault(temporary.vaultId);

    const saved = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null") as { vaults: Array<{ vaultId: string }>; workspaces: Array<{ currentVaultId: string | null }> };
    expect(saved.vaults.map((vault) => vault.vaultId)).toEqual([permanent.vaultId]);
    expect(saved.workspaces[0]?.currentVaultId).toBe(permanent.vaultId);
  });

  it("persists selection and display-name changes without changing the root", () => {
    const store = new WorkspaceStore();
    const first = store.registerVault("/a", "A");
    const second = store.registerVault("/b", "B");
    store.selectVault(first.vaultId);
    store.renameVault(first.vaultId, "Renamed");
    const saved = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null") as { vaults: Array<{ rootPath: string; displayName: string }>; workspaces: Array<{ currentVaultId: string | null }> };
    expect(saved.workspaces[0]?.currentVaultId).toBe(first.vaultId);
    expect(saved.vaults.find((vault) => vault.rootPath === "/a")?.displayName).toBe("Renamed");
    expect(second.rootPath).toBe("/b");
  });

  it("restores the last selected permanent vault without promoting a temporary selection", () => {
    const firstStore = new WorkspaceStore();
    const first = firstStore.registerVault("/a", "A");
    const second = firstStore.registerVault("/b", "B");
    const temporary = firstStore.createTemporaryVault("/tmp/session", "Session");
    firstStore.selectVault(first.vaultId);
    firstStore.selectVault(temporary.vaultId);

    const saved = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null") as { workspaces: Array<{ lastSelectedPermanentVaultId: string | null }> };
    expect(saved.workspaces[0]?.lastSelectedPermanentVaultId).toBe(first.vaultId);

    const restartedStore = new WorkspaceStore();
    const workspace = restartedStore.get().workspaces[0];
    expect(workspace?.lastSelectedPermanentVaultId).toBe(first.vaultId);
    expect(workspace?.currentVaultId).toBe(first.vaultId);
    expect(restartedStore.get().vaults.map((vault) => vault.vaultId)).toEqual([first.vaultId, second.vaultId]);
    expect(restartedStore.get().sessionTemporaryVaults).toEqual([]);
  });

  it("unregisters metadata only and leaves the filesystem path represented nowhere else", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/user/content", "Content");
    expect(store.unregisterVault(vault.vaultId).rootPath).toBe("/user/content");
    expect(store.get().vaults).toEqual([]);
    expect(store.get().workspaces[0]?.currentVaultId).toBeNull();
  });
});
