import { beforeEach, describe, expect, it } from "vitest";
import { selectVaultView, VaultTabStore } from "../src/workspace/vault-tabs";
import { GLOBAL_VAULT_ID } from "../src/workspace/workspace-state";

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

  it("keeps global tabs session-only even when a persistent scope is requested", () => {
    const tabs = new VaultTabStore();
    tabs.open(GLOBAL_VAULT_ID, "/tmp/draft.md", "permanent");

    expect(tabs.get(GLOBAL_VAULT_ID).tabs[0]?.path).toBe("/tmp/draft.md");
    expect(localStorage.getItem(`mermark.vaultTabs.${GLOBAL_VAULT_ID}`)).toBeNull();
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

  it("restores each permanent vault independently while leaving global tabs absent after restart", () => {
    const firstStore = new VaultTabStore();
    const a = firstStore.open("vault-a", "/notes/a.md", "permanent");
    const aActive = firstStore.open("vault-a", "/notes/active.md", "permanent");
    const b = firstStore.open("vault-b", "/docs/b.md", "permanent");
    firstStore.open(GLOBAL_VAULT_ID, "/tmp/draft.md", "session");

    const restartedStore = new VaultTabStore();

    expect(restartedStore.get("vault-a")).toEqual({
      vaultId: "vault-a",
      tabs: [a, aActive],
      activeTabId: aActive.tabId,
    });
    expect(restartedStore.get("vault-b")).toEqual({ vaultId: "vault-b", tabs: [b], activeTabId: b.tabId });
    expect(restartedStore.get(GLOBAL_VAULT_ID)).toEqual({ vaultId: GLOBAL_VAULT_ID, tabs: [], activeTabId: null });
    expect(localStorage.getItem(`mermark.vaultTabs.${GLOBAL_VAULT_ID}`)).toBeNull();
  });

  it("selects the welcome view when a vault has no restorable active tab", () => {
    expect(selectVaultView({ vaultId: "vault-empty", tabs: [], activeTabId: null })).toEqual({ kind: "welcome" });
  });

  it("selects an existing tab and persists only permanent active state", () => {
    const tabs = new VaultTabStore();
    const first = tabs.open("vault-a", "/notes/a.md", "permanent");
    const second = tabs.open("vault-a", "/notes/b.md", "permanent");

    expect(tabs.select("vault-a", first.tabId, "permanent").activeTabId).toBe(first.tabId);
    expect(JSON.parse(localStorage.getItem("mermark.vaultTabs.vault-a") ?? "null").activeTabId).toBe(first.tabId);

    const sessionFirst = tabs.open(GLOBAL_VAULT_ID, "/tmp/a.md", "session");
    const sessionSecond = tabs.open(GLOBAL_VAULT_ID, "/tmp/b.md", "session");
    expect(tabs.select(GLOBAL_VAULT_ID, sessionFirst.tabId, "permanent").activeTabId).toBe(sessionFirst.tabId);
    expect(tabs.get(GLOBAL_VAULT_ID).tabs.map((tab) => tab.tabId)).toEqual([sessionFirst.tabId, sessionSecond.tabId]);
    expect(localStorage.getItem(`mermark.vaultTabs.${GLOBAL_VAULT_ID}`)).toBeNull();
  });

  it("closes an active tab and selects the next remaining tab", () => {
    const tabs = new VaultTabStore();
    const first = tabs.open("vault-a", "/notes/a.md", "permanent");
    const second = tabs.open("vault-a", "/notes/b.md", "permanent");
    tabs.open("vault-a", "/notes/c.md", "permanent");

    const next = tabs.close("vault-a", second.tabId, "permanent");

    expect(next.tabs.map((tab) => tab.tabId)).toEqual([first.tabId, "vault-a-tab-%2Fnotes%2Fc.md"]);
    expect(next.activeTabId).toBe("vault-a-tab-%2Fnotes%2Fc.md");
    expect(selectVaultView(next)).toEqual({ kind: "document", tab: next.tabs[1] });
  });

  it("closes an inactive tab without changing the active selection in permanent storage", () => {
    const tabs = new VaultTabStore();
    const inactive = tabs.open("vault-a", "/notes/a.md", "permanent");
    const active = tabs.open("vault-a", "/notes/b.md", "permanent");

    const next = tabs.close("vault-a", inactive.tabId, "permanent");
    const saved = JSON.parse(localStorage.getItem("mermark.vaultTabs.vault-a") ?? "null") as { tabs: readonly { readonly tabId: string }[]; activeTabId: string | null };

    expect(next.activeTabId).toBe(active.tabId);
    expect(next.tabs.map((tab) => tab.tabId)).toEqual([active.tabId]);
    expect(saved.activeTabId).toBe(active.tabId);
    expect(saved.tabs.map((tab) => tab.tabId)).toEqual([active.tabId]);
  });

  it("closes the final global tab without persisting it and returns to welcome", () => {
    const tabs = new VaultTabStore();
    const tab = tabs.open(GLOBAL_VAULT_ID, "/tmp/draft.md", "session");

    const next = tabs.close(GLOBAL_VAULT_ID, tab.tabId, "permanent");

    expect(next).toEqual({ vaultId: GLOBAL_VAULT_ID, tabs: [], activeTabId: null });
    expect(selectVaultView(next)).toEqual({ kind: "welcome" });
    expect(localStorage.getItem(`mermark.vaultTabs.${GLOBAL_VAULT_ID}`)).toBeNull();
  });
});
