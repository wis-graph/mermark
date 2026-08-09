import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceSidebar } from "../src/workspace/workspace-sidebar";
import { WorkspaceStore } from "../src/workspace/workspace-state";
import type { VaultTabs } from "../src/workspace/vault-tabs";

describe("workspace sidebar", () => {
  beforeEach(() => localStorage.clear());

  it("replaces favorites presentation with selectable, renameable, removable vault rows", () => {
    const store = new WorkspaceStore();
    const onSelectVault = vi.fn();
    const sidebar = createWorkspaceSidebar({ store, onSelectVault, promptForPath: () => "/notes/project", promptForName: () => "Renamed" });
    document.body.append(sidebar.aside, sidebar.button);

    sidebar.aside.querySelector<HTMLButtonElement>(".workspace-action")?.click();
    expect(sidebar.aside.querySelectorAll(".workspace-vault-row")).toHaveLength(1);
    expect(sidebar.aside.querySelector(".workspace-vault-path")?.textContent).toBe("/notes/project");
    sidebar.aside.querySelector<HTMLButtonElement>(".workspace-vault-select")?.click();
    expect(onSelectVault).toHaveBeenCalledWith(expect.objectContaining({ rootPath: "/notes/project" }));
    sidebar.aside.querySelector<HTMLButtonElement>(".workspace-vault-action")?.click();
    expect(sidebar.aside.querySelector(".workspace-vault-name")?.textContent).toBe("Renamed");
  });

  it("renders the selected vault tabs and marks the active tab", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tabs: VaultTabs = { vaultId: vault.vaultId, tabs: [{ tabId: "tab-1", path: "/notes/readme.md" }], activeTabId: "tab-1" };
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), getTabs: () => tabs });
    document.body.append(sidebar.aside);

    expect(sidebar.aside.querySelector(".workspace-vault-tab")?.textContent).toBe("readme.md");
    expect(sidebar.aside.querySelector(".workspace-vault-tab")?.getAttribute("data-active")).toBe("true");
  });

  it("opens a clicked vault tab through the injected document handler", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const onSelectTab = vi.fn();
    const tabs: VaultTabs = { vaultId: vault.vaultId, tabs: [{ tabId: "tab-1", path: "/notes/readme.md" }], activeTabId: "tab-1" };
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), getTabs: () => tabs, onSelectTab });
    document.body.append(sidebar.aside);

    sidebar.aside.querySelector<HTMLButtonElement>(".workspace-vault-tab")?.click();

    expect(onSelectTab).toHaveBeenCalledWith(vault, tabs.tabs[0]);
  });

  it("closes competing panels when workspace opens", () => {
    const store = new WorkspaceStore();
    const onOpen = vi.fn();
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), onOpen });

    sidebar.button.click();

    expect(onOpen).toHaveBeenCalledOnce();
  });
});
