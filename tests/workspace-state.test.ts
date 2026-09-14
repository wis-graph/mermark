import { beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_VAULT_ID, REMOTE_VAULT_WIRE_ROOT, WorkspaceStateError, WorkspaceStore, anyVaultStillUsesHost, canonicalRootPath, workspaceStorageKey } from "../src/workspace/workspace-state";

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

  // Pins the invariant main.ts:434 (explorerRootForVault) leans on without a
  // type-level guarantee: PermanentVault.explorerRoot === rootPath. registerVault
  // (above) proves it at creation; this proves the second writer, readState's
  // reload path (workspace-state.ts's loadState-equivalent), doesn't let the two
  // fields drift even if a stored blob has them out of sync.
  it("re-derives explorerRoot from rootPath on reload, even if the stored blob disagrees", () => {
    const firstStore = new WorkspaceStore();
    const vault = firstStore.registerVault("/notes/project", "Project");
    const saved = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null") as { vaults: Array<Record<string, unknown>> };
    const tampered = { ...saved, vaults: saved.vaults.map((item) => item.vaultId === vault.vaultId ? { ...item, explorerRoot: "/somewhere/else" } : item) };
    localStorage.setItem(workspaceStorageKey, JSON.stringify(tampered));

    const restartedStore = new WorkspaceStore();
    const reloaded = restartedStore.getVault(vault.vaultId);
    expect(reloaded?.explorerRoot).toBe(reloaded?.rootPath);
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

  // selectVault no-op guard (selectionIsNoop, workspace-state.ts): reselecting
  // a vault that's already fully selected must not commit/notify — a click on
  // an already-active workspace-sidebar row was blowing away DOM focus
  // because selectVault always committed, unconditionally re-rendering the
  // list on every click regardless of whether anything changed.
  it("reselecting the already-active permanent vault is a no-op: no notify, same vault returned", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes", "Notes");
    let notifyCount = 0;
    store.subscribe(() => { notifyCount++; });

    const reselected = store.selectVault(vault.vaultId);

    expect(notifyCount).toBe(0);
    expect(reselected.vaultId).toBe(vault.vaultId);
  });

  it("reselecting the global vault while already global is a no-op", () => {
    const store = new WorkspaceStore();
    store.registerVault("/notes", "Notes");
    store.selectVault(GLOBAL_VAULT_ID);
    let notifyCount = 0;
    store.subscribe(() => { notifyCount++; });

    const reselected = store.selectVault(GLOBAL_VAULT_ID);

    expect(notifyCount).toBe(0);
    expect(reselected.vaultId).toBe(GLOBAL_VAULT_ID);
  });

  it("still commits (and repairs lastSelectedPermanentVaultId) when currentVaultId already matches but lastSelectedPermanentVaultId has drifted", () => {
    // Craft a desynced restored state: currentVaultId already equals vaultA,
    // but lastSelectedPermanentVaultId still points at vaultB — the exact
    // shape a naive `currentVaultId === vaultId` guard would wrongly treat as
    // a no-op, silently swallowing the lastSelectedPermanentVaultId repair.
    const seedStore = new WorkspaceStore();
    const vaultA = seedStore.registerVault("/a", "A");
    const vaultB = seedStore.registerVault("/b", "B");
    const raw = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null") as { workspaces: Array<{ currentVaultId: string | null; lastSelectedPermanentVaultId: string | null }> };
    raw.workspaces[0]!.currentVaultId = vaultA.vaultId;
    raw.workspaces[0]!.lastSelectedPermanentVaultId = vaultB.vaultId;
    localStorage.setItem(workspaceStorageKey, JSON.stringify(raw));

    const store = new WorkspaceStore();
    let notifyCount = 0;
    store.subscribe(() => { notifyCount++; });

    const reselected = store.selectVault(vaultA.vaultId);

    expect(notifyCount).toBe(1); // NOT a no-op — must commit to repair the drift
    expect(reselected.vaultId).toBe(vaultA.vaultId);
    expect(store.get().workspaces[0]?.lastSelectedPermanentVaultId).toBe(vaultA.vaultId);
  });

  it("unregisters metadata only and leaves the filesystem path represented nowhere else", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/user/content", "Content");
    expect(store.unregisterVault(vault.vaultId).rootPath).toBe("/user/content");
    expect(store.get().vaults).toEqual([]);
    expect(store.get().workspaces[0]?.currentVaultId).toBe(GLOBAL_VAULT_ID);
  });

  // Ruling 21: a paired remote vault must round-trip through a restart, same
  // as a permanent one — before Task 10, readState's guard accepted only
  // persistenceKind === "permanent" and commit's saveState filter dropped
  // everything else, so a remote vault vanished the moment the app restarted.
  describe("remote vaults", () => {
    it("registers a remote vault, selects it, and survives a reload", () => {
      const firstStore = new WorkspaceStore();
      const remote = firstStore.registerRemoteVault("wis-macmini:8787", "rv-abc", "맥미니 노트");

      expect(remote.persistenceKind).toBe("remote");
      expect(remote.rootPath).toBeNull();
      expect(firstStore.get().workspaces[0]?.currentVaultId).toBe(remote.vaultId);

      const restartedStore = new WorkspaceStore();
      const reloaded = restartedStore.getVault(remote.vaultId);
      expect(reloaded).toMatchObject({ persistenceKind: "remote", host: "wis-macmini:8787", remoteVaultId: "rv-abc", displayName: "맥미니 노트" });
      expect(restartedStore.get().workspaces[0]?.vaultIds).toContain(remote.vaultId);
      expect(restartedStore.get().workspaces[0]?.currentVaultId).toBe(remote.vaultId);
    });

    // C1 (final-review-ts.md): the host's own wire contract (remote_host.rs's
    // `safe_path`) treats ONLY the empty string as "the vault root" — any
    // non-empty path (including "/") goes through `resolve_within`, which
    // rejects a leading `RootDir` component and 404s. A `RemoteVault` whose
    // `explorerRoot` is `"/"` therefore can never list its own root against a
    // real host: every badge probe and every Explorer root-jump 404s and gets
    // misclassified as "호스트가 공유를 껐음" even though sharing is on. Pinned
    // here (not just at the wire-constant's declaration) so a future change to
    // either registration path can't silently regress back to "/".
    it("gives a freshly registered remote vault the wire-root value, not a local-looking \"/\"", () => {
      const store = new WorkspaceStore();
      const remote = store.registerRemoteVault("wis-macmini", "rv-1", "원격");
      expect(remote.explorerRoot).toBe(REMOTE_VAULT_WIRE_ROOT);
      expect(remote.explorerRoot).toBe("");
    });

    it("restores the wire-root value for a remote vault reloaded from storage", () => {
      const firstStore = new WorkspaceStore();
      firstStore.registerRemoteVault("wis-macmini", "rv-1", "원격");
      const restarted = new WorkspaceStore();
      const reloaded = restarted.get().vaults.find((v) => v.persistenceKind === "remote");
      expect(reloaded?.explorerRoot).toBe(REMOTE_VAULT_WIRE_ROOT);
    });

    it("rejects pairing the same host+remoteVaultId twice", () => {
      const store = new WorkspaceStore();
      store.registerRemoteVault("wis-macmini", "rv-1", "노트");
      expect(() => store.registerRemoteVault("wis-macmini", "rv-1", "다시")).toThrowError(WorkspaceStateError);
    });

    it("selecting a remote vault never writes lastSelectedPermanentVaultId, so a permanent vault is still restored after a global excursion", () => {
      const store = new WorkspaceStore();
      const permanent = store.registerVault("/notes", "Notes");
      const remote = store.registerRemoteVault("wis-macmini", "rv-1", "원격");
      store.selectVault(permanent.vaultId);
      store.selectVault(remote.vaultId);
      store.selectVault(GLOBAL_VAULT_ID);

      const saved = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null") as { workspaces: Array<{ lastSelectedPermanentVaultId: string | null }> };
      expect(saved.workspaces[0]?.lastSelectedPermanentVaultId).toBe(permanent.vaultId);

      const restarted = new WorkspaceStore();
      expect(restarted.get().workspaces[0]?.lastSelectedPermanentVaultId).toBe(permanent.vaultId);
    });

    it("unregisters a remote vault by id", () => {
      const store = new WorkspaceStore();
      const remote = store.registerRemoteVault("wis-macmini", "rv-1", "원격");
      expect(store.unregisterVault(remote.vaultId).persistenceKind).toBe("remote");
      expect(store.get().vaults).toEqual([]);
    });

    // Fix round 2, Important B: registerRemoteVault dedupes on
    // (host, remoteVaultId), not host alone — two vaults from the same
    // host's share list can coexist, and removing one must not signal that
    // the shared SSH tunnel is safe to tear down while the other still
    // needs it.
    describe("anyVaultStillUsesHost (SSH tunnel sharing, fix round 2 Important B)", () => {
      it("two vaults can share one ssh host, and removing one still leaves the host in use", () => {
        const store = new WorkspaceStore();
        const first = store.registerRemoteVault("ssh://wis@macmini", "rv-1", "볼트1");
        const second = store.registerRemoteVault("ssh://wis@macmini", "rv-2", "볼트2");
        expect(anyVaultStillUsesHost(store.get().vaults, "ssh://wis@macmini")).toBe(true);

        store.unregisterVault(first.vaultId);
        // The sibling (rv-2) is still registered against the same host — the
        // tunnel must NOT be torn down.
        expect(anyVaultStillUsesHost(store.get().vaults, "ssh://wis@macmini")).toBe(true);
        expect(store.get().vaults.map((v) => v.vaultId)).toEqual([second.vaultId]);

        store.unregisterVault(second.vaultId);
        // Now nothing on that host remains — safe to disconnect.
        expect(anyVaultStillUsesHost(store.get().vaults, "ssh://wis@macmini")).toBe(false);
      });

      it("a vault on a different host never counts toward the removed vault's host", () => {
        const store = new WorkspaceStore();
        store.registerRemoteVault("ssh://wis@other-host", "rv-1", "다른호스트");
        expect(anyVaultStillUsesHost(store.get().vaults, "ssh://wis@macmini")).toBe(false);
      });
    });
  });
});
