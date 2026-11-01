import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFolderVaultBookmarks, folderBookmarkTargetFor } from "../src/workspace/folder-vault-bookmark";
import { GLOBAL_VAULT_ID, WorkspaceStore, type Vault } from "../src/workspace/workspace-state";

beforeEach(() => localStorage.clear());

function setup(browse: (store: WorkspaceStore) => Vault, canonical = "/Users/me/notes/deep") {
  const store = new WorkspaceStore();
  const browsing = browse(store);
  const canonicalizeLocal = vi.fn(async (p: string) => (p.startsWith("/root") ? p : canonical));
  const setRoutedVault = vi.fn();
  const reportError = vi.fn();
  const b = createFolderVaultBookmarks({ store, browsingVault: () => browsing, canonicalizeLocal, setRoutedVault, reportError });
  return { store, browsing, canonicalizeLocal, setRoutedVault, reportError, ...b };
}
const remoteRoot = (store: WorkspaceStore) => store.registerRemoteVault("h", "rv", "root");

describe("folderBookmarkTargetFor", () => {
  it("routes by browsing vault kind", () => {
    const store = new WorkspaceStore();
    const remote = remoteRoot(store);
    expect(folderBookmarkTargetFor(remote, "notes/deep")).toMatchObject({ kind: "remote", root: "notes/deep" });
    expect(folderBookmarkTargetFor(remote, "a/../b")).toMatchObject({ kind: "remote", root: null });
    expect(folderBookmarkTargetFor(store.registerVault("/tmp/fvb"), "/tmp/fvb/x")).toEqual({ kind: "local", path: "/tmp/fvb/x" });
    expect(folderBookmarkTargetFor(store.getGlobalVault(), "/x")).toEqual({ kind: "local", path: "/x" });
    expect(folderBookmarkTargetFor(undefined, "/x")).toEqual({ kind: "local", path: "/x" });
  });
});

describe("remote branch (I2: never touches canonicalize_path)", () => {
  it("isRegistered is IPC-free", async () => {
    const t = setup(remoteRoot);
    expect(await t.isRegistered("notes/deep")).toBe(false);
    expect(t.canonicalizeLocal).not.toHaveBeenCalled();
  });

  it("toggle registers a folder vault, keeps browsing selection, and never canonicalizes", async () => {
    const t = setup(remoteRoot);
    await t.toggle("notes/deep");
    const folder = t.store.get().vaults.find((v) => v.persistenceKind === "remote" && v.explorerRoot === "notes/deep");
    expect(folder).toMatchObject({ displayName: "deep", host: "h", remoteVaultId: "rv" });
    expect(t.canonicalizeLocal).not.toHaveBeenCalled();
    expect(await t.isRegistered("notes/deep")).toBe(true);
    expect(t.store.get().workspaces[0]?.currentVaultId).toBe(t.browsing.vaultId);
    expect(t.setRoutedVault).toHaveBeenLastCalledWith(t.browsing);
  });

  it("toggling again unregisters without changing selection or routing", async () => {
    const t = setup(remoteRoot);
    await t.toggle("notes/deep");
    t.setRoutedVault.mockClear();
    await t.toggle("notes/deep");
    expect(t.store.get().vaults.map((v) => v.vaultId)).toEqual([t.browsing.vaultId]);
    expect(t.setRoutedVault).not.toHaveBeenCalled();
    expect(t.store.get().workspaces[0]?.currentVaultId).toBe(t.browsing.vaultId);
    expect(t.canonicalizeLocal).not.toHaveBeenCalled();
  });

  it("never registers a same-named LOCAL folder", async () => {
    const t = setup(remoteRoot, "/Users/me/notes/deep");
    await t.toggle("notes/deep");
    expect(t.store.get().vaults.every((v) => v.persistenceKind === "remote")).toBe(true);
  });

  it("toggling the folder vault being browsed from inside it is a no-op", async () => {
    const t = setup((s) => s.registerRemoteVault("h", "rv", "deep", "notes/deep"));
    await t.toggle("notes/deep");
    expect(t.store.get().vaults).toHaveLength(1);
    expect(t.reportError).not.toHaveBeenCalled();
  });

  it("another host/id's same path does not count as registered", async () => {
    const t = setup(remoteRoot);
    t.store.registerRemoteVault("h2", "rv", "deep", "notes/deep");
    t.store.registerRemoteVault("h", "rv2", "deep", "notes/deep");
    expect(await t.isRegistered("notes/deep")).toBe(false);
  });

  it("a traversal path reports an error and leaves the store alone", async () => {
    const t = setup(remoteRoot);
    await t.toggle("a/../b");
    expect(t.reportError).toHaveBeenCalledTimes(1);
    expect(t.store.get().vaults).toHaveLength(1);
  });

  it("M1: browsing vault unregistered from the sidebar, then toggling a row: registers, no alert, selection not forced to a missing vault", async () => {
    const t = setup(remoteRoot);
    const other = t.store.registerVault("/Users/me/other");
    t.store.unregisterVault(t.browsing.vaultId);
    t.store.selectVault(other.vaultId);
    await t.toggle("notes/deep");
    expect(t.reportError).not.toHaveBeenCalled();
    expect(t.store.get().vaults.some((v) => v.persistenceKind === "remote" && v.explorerRoot === "notes/deep")).toBe(true);
    expect(t.store.get().workspaces[0]?.currentVaultId).toBe(other.vaultId);
  });

  it("M1: selection that differed from the browsing vault is restored, not forced to browsing", async () => {
    const t = setup(remoteRoot);
    const other = t.store.registerVault("/Users/me/other");
    await t.toggle("notes/deep");
    expect(t.store.get().workspaces[0]?.currentVaultId).toBe(other.vaultId);
  });

  it("nested registration from a folder vault uses the full vault-relative path", async () => {
    const t = setup((s) => s.registerRemoteVault("h", "rv", "deep", "notes/deep"));
    await t.toggle("notes/deep/x");
    expect(t.store.get().vaults.find((v) => v.persistenceKind === "remote" && v.explorerRoot === "notes/deep/x")).toMatchObject({ host: "h", remoteVaultId: "rv" });
  });
});

describe("local branch guard (M3)", () => {
  it("a relative row path with a local browsing vault never reaches canonicalize_path", async () => {
    const t = setup((s) => s.registerVault("/root"));
    expect(await t.isRegistered("notes/deep")).toBe(false);
    await t.toggle("notes/deep");
    expect(t.canonicalizeLocal).not.toHaveBeenCalled();
    expect(t.store.get().vaults).toHaveLength(1);
  });
});

describe("local branch (behaviour preserved)", () => {
  it("registers via canonicalize and routes to the new vault", async () => {
    const t = setup((s) => s.registerVault("/root"));
    await t.toggle("/root/sub");
    expect(t.canonicalizeLocal).toHaveBeenCalledWith("/root/sub");
    const registered = t.store.get().vaults.find((v) => v.rootPath === "/root/sub")!;
    expect(registered.persistenceKind).toBe("permanent");
    expect(t.setRoutedVault).toHaveBeenLastCalledWith(registered);
  });

  it("from the global vault keeps global selected", async () => {
    const t = setup((s) => s.getGlobalVault());
    await t.toggle("/root/sub");
    expect(t.store.get().workspaces[0]?.currentVaultId).toBe(GLOBAL_VAULT_ID);
    expect(t.setRoutedVault).toHaveBeenLastCalledWith(expect.objectContaining({ persistenceKind: "global" }));
  });

  it("unregisters on second toggle; routes to undefined when it was the current vault", async () => {
    const store = new WorkspaceStore();
    const sub = store.registerVault("/root/sub");
    const setRoutedVault = vi.fn();
    const b = createFolderVaultBookmarks({ store, browsingVault: () => sub, canonicalizeLocal: async (p) => p, setRoutedVault, reportError: vi.fn() });
    await b.toggle("/root/sub");
    expect(store.get().vaults).toHaveLength(0);
    expect(setRoutedVault).toHaveBeenLastCalledWith(undefined);
  });

  it("reports canonicalize failures", async () => {
    const store = new WorkspaceStore();
    const reportError = vi.fn();
    const b = createFolderVaultBookmarks({ store, browsingVault: () => store.registerVault("/root"), canonicalizeLocal: async () => { throw new Error("nope"); }, setRoutedVault: vi.fn(), reportError });
    await b.toggle("/root/x");
    expect(reportError).toHaveBeenCalledWith("nope");
  });
});
