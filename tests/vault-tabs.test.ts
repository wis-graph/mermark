import { beforeEach, describe, expect, it } from "vitest";
import { selectVaultView, VaultTabStore } from "../src/workspace/vault-tabs";

describe("VaultTabStore", () => {
  beforeEach(() => localStorage.clear());

  it("keeps persistent vault tabs and active tab separate by vault", () => {
    const tabs = new VaultTabStore();
    const first = tabs.open("vault-a", "/notes/a.md", "permanent");
    tabs.open("vault-b", "/docs/b.md", "permanent");

    expect(tabs.get("vault-a").activeTabId).toBe(first.tabId);
    expect(tabs.get("vault-a").tabs[0]?.path).toBe("/notes/a.md");
    expect(tabs.get("vault-b").tabs[0]?.path).toBe("/docs/b.md");
    expect(JSON.parse(localStorage.getItem("mermark.vaultTabs.vault-a") ?? "null").tabs).toHaveLength(1);
  });

  it("does not persist temporary session tabs", () => {
    const tabs = new VaultTabStore();
    tabs.open("session-1", "/tmp/draft.md", "session");

    expect(tabs.get("session-1").tabs[0]?.path).toBe("/tmp/draft.md");
    expect(localStorage.getItem("mermark.vaultTabs.session-1")).toBeNull();
  });

  it("restores persistent tabs and the active tab after a store is recreated", () => {
    const firstStore = new VaultTabStore();
    firstStore.open("vault-a", "/notes/a.md", "permanent");
    const active = firstStore.open("vault-a", "/notes/b.md", "permanent");

    const restartedStore = new VaultTabStore();

    expect(restartedStore.get("vault-a")).toEqual({
      vaultId: "vault-a",
      tabs: [
        { tabId: "vault-a-tab-%2Fnotes%2Fa.md", path: "/notes/a.md" },
        { tabId: active.tabId, path: "/notes/b.md" },
      ],
      activeTabId: active.tabId,
    });
  });

  it("restores each permanent vault independently while leaving session tabs absent after restart", () => {
    const firstStore = new VaultTabStore();
    const a = firstStore.open("vault-a", "/notes/a.md", "permanent");
    const aActive = firstStore.open("vault-a", "/notes/active.md", "permanent");
    const b = firstStore.open("vault-b", "/docs/b.md", "permanent");
    firstStore.open("session-1", "/tmp/draft.md", "session");

    const restartedStore = new VaultTabStore();

    expect(restartedStore.get("vault-a")).toEqual({
      vaultId: "vault-a",
      tabs: [a, aActive],
      activeTabId: aActive.tabId,
    });
    expect(restartedStore.get("vault-b")).toEqual({ vaultId: "vault-b", tabs: [b], activeTabId: b.tabId });
    expect(restartedStore.get("session-1")).toEqual({ vaultId: "session-1", tabs: [], activeTabId: null });
    expect(localStorage.getItem("mermark.vaultTabs.session-1")).toBeNull();
  });

  it("selects the welcome view when a vault has no restorable active tab", () => {
    expect(selectVaultView({ vaultId: "vault-empty", tabs: [], activeTabId: null })).toEqual({ kind: "welcome" });
  });
});
