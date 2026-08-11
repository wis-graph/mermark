import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceSidebar } from "../src/workspace/workspace-sidebar";
import { GLOBAL_VAULT_ID, WorkspaceStore } from "../src/workspace/workspace-state";
import type { VaultTabs } from "../src/workspace/vault-tabs";

describe("workspace sidebar", () => {
  beforeEach(() => localStorage.clear());

  it("renders vault rows without global registration or rename controls", () => {
    const store = new WorkspaceStore();
    const onSelectVault = vi.fn();
    const vault = store.registerVault("/notes/project", "Project");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault });
    document.body.append(sidebar.aside, sidebar.button);

    expect(sidebar.aside.querySelectorAll(".workspace-vault-row")).toHaveLength(2);
    expect(sidebar.aside.querySelector(".workspace-id")).toBeNull();
    expect(sidebar.aside.querySelector(".workspace-vault-group-label")).toBeNull();
    expect(sidebar.aside.querySelectorAll("[role=heading]")).toHaveLength(0);
    expect(sidebar.aside.querySelector(`[data-vault-id="${GLOBAL_VAULT_ID}"]`)).toBeTruthy();
    expect(sidebar.aside.textContent).toContain("글로벌 볼트");
    expect(sidebar.aside.querySelector(`[data-vault-id="${GLOBAL_VAULT_ID}"]`)?.compareDocumentPosition(sidebar.aside.querySelector(`[data-vault-id="${vault.vaultId}"]`) as Node) && Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sidebar.aside.querySelector(".workspace-vault-path")).toBeNull();
    const permanentRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`);
    expect(permanentRow?.querySelector<HTMLButtonElement>(".workspace-vault-select")?.title).toBe("/notes/project");
    permanentRow?.querySelector<HTMLButtonElement>(".workspace-vault-select")?.click();
    expect(onSelectVault).toHaveBeenCalledWith(vault);
    expect(sidebar.aside.querySelector(".workspace-action")).toBeNull();
    expect(sidebar.aside.querySelector(".icon-square-pen")).toBeNull();
    expect(sidebar.aside.textContent).not.toContain("볼트 등록");
    expect(sidebar.aside.textContent).not.toContain("이름 변경");
  });

  it("renders the selected vault tabs and marks the active tab", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tabs: VaultTabs = { vaultId: vault.vaultId, tabs: [{ tabId: "tab-1", path: "/notes/readme.md" }], activeTabId: "tab-1" };
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), getTabs: () => tabs });
    document.body.append(sidebar.aside);

    expect(sidebar.aside.querySelector(".workspace-vault-tab")?.textContent).toBe("readme.md");
    expect(sidebar.aside.querySelector(".workspace-vault-tab")?.getAttribute("data-active")).toBe("true");
    expect(sidebar.aside.querySelector(".workspace-vault-tabs-label")).toBeNull();
    expect(sidebar.aside.querySelector(".workspace-vault-tabs")?.getAttribute("role")).toBe("tablist");
    const permanentRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`);
    expect(permanentRow?.querySelector(".workspace-vault-tabs")?.getAttribute("aria-label")).toBe("Project 탭");
    expect(permanentRow?.querySelector(".workspace-vault-tab")?.getAttribute("role")).toBe("tab");
    expect(permanentRow?.querySelector(".workspace-vault-tab")?.getAttribute("aria-selected")).toBe("true");
    expect(permanentRow?.querySelector(".workspace-vault-tab")?.getAttribute("tabindex")).toBe("0");
    expect(permanentRow?.querySelector(".workspace-vault-tab")?.getAttribute("aria-current")).toBe("page");
  });

  it("moves the roving tab focus and activates the tab with horizontal keys", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const onSelectTab = vi.fn();
    const tabs: VaultTabs = {
      vaultId: vault.vaultId,
      tabs: [{ tabId: "tab-1", path: "/notes/one.md" }, { tabId: "tab-2", path: "/notes/two.md" }, { tabId: "tab-3", path: "/notes/three.md" }],
      activeTabId: "tab-1",
    };
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), getTabs: () => tabs, onSelectTab });
    document.body.append(sidebar.aside);
    const tab = sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-1"]`);
    tab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(onSelectTab).toHaveBeenCalledWith(vault, tabs.tabs[1]);
    expect(sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-2"]`)?.tabIndex).toBe(0);
    expect(sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-1"]`)?.tabIndex).toBe(-1);

    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-2"]`)?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(onSelectTab).toHaveBeenLastCalledWith(vault, tabs.tabs[2]);
    expect(sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-3"]`)?.tabIndex).toBe(0);
  });

  it("keeps the selected tab tabbable when keyboard activation is rejected", async () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tabs: VaultTabs = {
      vaultId: vault.vaultId,
      tabs: [{ tabId: "tab-1", path: "/notes/one.md" }, { tabId: "tab-2", path: "/notes/two.md" }],
      activeTabId: "tab-1",
    };
    const sidebar = createWorkspaceSidebar({
      store,
      onSelectVault: vi.fn(),
      getTabs: () => tabs,
      onSelectTab: () => Promise.resolve(false),
    });
    document.body.append(sidebar.aside);
    const active = sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-1"]`);
    active?.focus();
    active?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(active?.getAttribute("aria-selected")).toBe("true");
    expect(active?.tabIndex).toBe(0);
    expect(document.activeElement).toBe(active);
    expect(sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-2"]`)?.tabIndex).toBe(-1);
  });

  it("opens a clicked vault tab through the injected document handler", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const onSelectTab = vi.fn();
    const tabs: VaultTabs = { vaultId: vault.vaultId, tabs: [{ tabId: "tab-1", path: "/notes/readme.md" }], activeTabId: "tab-1" };
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), getTabs: () => tabs, onSelectTab });
    document.body.append(sidebar.aside);

    sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`)?.querySelector<HTMLButtonElement>(".workspace-vault-tab")?.click();

    expect(onSelectTab).toHaveBeenCalledWith(vault, tabs.tabs[0]);
    expect(store.get().workspaces[0]?.currentVaultId).toBe(vault.vaultId);
  });

  it("does not render temporary/session groups or per-document vault rows", () => {
    const store = new WorkspaceStore();
    store.registerVault("/notes/project", "Project");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    expect(sidebar.aside.querySelector(".workspace-vault-group--temporary")).toBeNull();
    expect(sidebar.aside.textContent).not.toContain("이번 세션");
  });

  it("exposes an accessible close action for each tab and delegates closing", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tab = { tabId: "tab-1", path: "/notes/readme.md" };
    const onCloseTab = vi.fn();
    const sidebar = createWorkspaceSidebar({
      store,
      onSelectVault: vi.fn(),
      getTabs: () => ({ vaultId: vault.vaultId, tabs: [tab], activeTabId: tab.tabId }),
      onCloseTab,
    });
    document.body.append(sidebar.aside);

    const close = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`)?.querySelector<HTMLButtonElement>(".workspace-vault-tab-close");
    close?.click();

    expect(close?.getAttribute("aria-label")).toBe("readme.md 탭 닫기");
    expect(onCloseTab).toHaveBeenCalledWith(vault, tab);
  });

  it("unregisters a permanent vault immediately without a browser confirmation dialog", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    expect(sidebar.aside.querySelector(`[data-vault-id="${vault.vaultId}"] .icon-bookmark-filled`)).toBeTruthy();
    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-action`)?.click();

    expect(store.get().vaults).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    expect(sidebar.aside.querySelector(`[data-vault-id="${vault.vaultId}"]`)).toBeNull();
  });

  it("closes competing panels when workspace opens", () => {
    const store = new WorkspaceStore();
    const onOpen = vi.fn();
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), onOpen });

    sidebar.button.click();

    expect(onOpen).toHaveBeenCalledOnce();
  });
});
