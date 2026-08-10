import { beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_VAULT_ID, WorkspaceStateError, WorkspaceStore, canonicalRootPath, workspaceStorageKey } from "../src/workspace/workspace-state";

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

  it("always exposes one runtime-only global vault without persisting it", () => {
    const store = new WorkspaceStore();
    const vault = store.getGlobalVault();

    expect(store.get().workspaces[0]?.currentVaultId).toBe(GLOBAL_VAULT_ID);
    expect(vault.vaultId).toBe(GLOBAL_VAULT_ID);
    expect(vault.persistenceKind).toBe("global");
    expect(vault.displayName).toBe("글로벌 볼트");
    expect(vault.rootPath).toBeNull();
    expect(vault.explorerRoot).toBeNull();
    expect(store.get().workspaces[0]?.vaultIds).toEqual([]);
    expect(store.get().vaults).toEqual([]);
    expect(localStorage.getItem(workspaceStorageKey)).toBeNull();
  });

  it("selects global in memory while preserving the persisted permanent selection", () => {
    const store = new WorkspaceStore();
    const permanent = store.registerVault("/notes", "Notes");
    store.selectVault(GLOBAL_VAULT_ID);

    expect(store.get().workspaces[0]?.currentVaultId).toBe(GLOBAL_VAULT_ID);
    const saved = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null") as { vaults: Array<{ vaultId: string }>; workspaces: Array<{ currentVaultId: string | null }> };
    expect(saved.vaults.map((vault) => vault.vaultId)).toEqual([permanent.vaultId]);
    expect(saved.workspaces[0]?.currentVaultId).toBe(permanent.vaultId);
  });

  it("does not expose a per-document session vault after a global selection", () => {
    const store = new WorkspaceStore();
    const global = store.getGlobalVault();

    store.selectVault(global.vaultId);

    expect(store.get().vaults).toEqual([]);
    expect(store.get().workspaces[0]?.vaultIds).toEqual([]);
  });

  it("normalizes an old empty workspace to global without migrating session vault rows", () => {
    localStorage.setItem(workspaceStorageKey, JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: [], currentVaultId: "session-old", lastSelectedPermanentVaultId: null }],
      vaults: [],
      sessionTemporaryVaults: [{ vaultId: "session-old", rootPath: "/scratch/file.md" }],
      currentWorkspaceId: "workspace-default",
    }));

    const store = new WorkspaceStore();

    expect(store.get().workspaces[0]?.currentVaultId).toBe(GLOBAL_VAULT_ID);
    expect(store.get()).not.toHaveProperty("sessionTemporaryVaults");
    expect(store.get().vaults).toEqual([]);
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

  it("restores the last selected permanent vault after a global selection", () => {
    const firstStore = new WorkspaceStore();
    const first = firstStore.registerVault("/a", "A");
    const second = firstStore.registerVault("/b", "B");
    firstStore.selectVault(first.vaultId);
    firstStore.selectVault(GLOBAL_VAULT_ID);

    const saved = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null") as { workspaces: Array<{ lastSelectedPermanentVaultId: string | null }> };
    expect(saved.workspaces[0]?.lastSelectedPermanentVaultId).toBe(first.vaultId);

    const restartedStore = new WorkspaceStore();
    const workspace = restartedStore.get().workspaces[0];
    expect(workspace?.lastSelectedPermanentVaultId).toBe(first.vaultId);
    expect(workspace?.currentVaultId).toBe(first.vaultId);
    expect(restartedStore.get().vaults.map((vault) => vault.vaultId)).toEqual([first.vaultId, second.vaultId]);
    expect(restartedStore.get()).not.toHaveProperty("sessionTemporaryVaults");
  });

  it("unregisters metadata only and leaves the filesystem path represented nowhere else", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/user/content", "Content");
    expect(store.unregisterVault(vault.vaultId).rootPath).toBe("/user/content");
    expect(store.get().vaults).toEqual([]);
    expect(store.get().workspaces[0]?.currentVaultId).toBe(GLOBAL_VAULT_ID);
  });
});
