import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pathArg = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null || !("path" in args) || typeof args.path !== "string") return undefined;
  return args.path;
};

const invokeMock = vi.fn((command: string, args?: unknown): Promise<unknown> => {
  const path = pathArg(args) ?? "";
  if (command === "canonicalize_path") return Promise.resolve(path);
  if (command === "read_file") return Promise.resolve({ text: "# document", mtime: 1 });
  if (command === "list_dir") {
    if (path === "/") return Promise.resolve([{ name: "A", path: "/A", is_dir: true }]);
    if (path === "/A") return Promise.resolve([{ name: "B", path: "/A/B", is_dir: true }, { name: "start.md", path: "/A/start.md", is_dir: false }]);
    if (path === "/A/B") return Promise.resolve([{ name: "doc.md", path: "/A/B/doc.md", is_dir: false }]);
    return Promise.resolve([]);
  }
  return Promise.resolve(false);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const mainSource = readFileSync("src/main.ts", "utf8");

describe("main workspace wiring", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { search: "?file=/A/start.md" });
    localStorage.clear();
    invokeMock.mockClear();
    const app = document.createElement("div");
    app.id = "app";
    document.body.append(app);
  });

  afterEach(() => {
    document.querySelector("#app")?.remove();
    Reflect.deleteProperty(window, "__mermark");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("injects the Explorer vault toggle and live root reporting", () => {
    expect(mainSource).toContain("onToggleVault: (root) => toggleExplorerVault(root)");
    expect(mainSource).toContain("isVaultRegistered: (root) =>");
    expect(mainSource).toContain("onRootChange: (root) => {");
    expect(mainSource).toContain("currentExplorerFolder = root");
    expect(mainSource).not.toContain("onAddVault");
    expect(mainSource).not.toContain("promoteExplorerFolder");
  });

  it("wires global navigation as a runtime-only, unrestricted selection", () => {
    expect(mainSource).toContain("const SAFE_EXPLORER_BASE_PATH = \"/\";");
    expect(mainSource).toContain('persistenceKind === "global"');
    expect(mainSource).toContain('if (currentVault()?.persistenceKind === "global") currentExplorerFolder = root;');
    expect(mainSource).not.toContain("preserveExplorerFolder");
    expect(mainSource).not.toContain("createTemporaryVault");
  });

  it("routes every no-document opener through the shared reload handoff", () => {
    expect(mainSource.match(/location\.href = createDocumentReloadUrl/g)).toHaveLength(4);
  });

  it("routes live tab selection and close fallback through main", () => {
    expect(mainSource).toContain("onSelectTab: (vault, tab) => {");
    expect(mainSource).toContain("const selectedVault = workspaceStore.selectVault(vault.vaultId);");
    expect(mainSource).toContain("vaultTabs.select(selectedVault.vaultId, tab.tabId");
    expect(mainSource).toContain("onCloseTab: (vault, tab) => {");
    expect(mainSource).toContain("vaultTabs.close(vault.vaultId, tab.tabId");
    expect(mainSource).toContain("renderWelcomeForVault()");
  });

  it("canonicalizes and registers or unregisters the matching permanent vault", () => {
    expect(mainSource).toContain('invoke("canonicalize_path", { path: root })');
    expect(mainSource).toContain("workspaceStore.registerCanonicalVault(canonical)");
    expect(mainSource).toContain("workspaceStore.unregisterVault(existing.vaultId)");
    expect(mainSource).toContain("workspaceStore.subscribe(() => { void explorer.refreshVaultToggles(); });");
    expect(mainSource).not.toContain("explorer.refreshVaultToggles();\n        workspaceSidebar.refresh();");
    expect(mainSource).toContain("window.alert(error instanceof Error ? error.message : error)");
  });

  it("migrates the removed legacy source without wiring a live favorite model", () => {
    expect(mainSource).toContain("readLegacyFavoriteFolders()");
    expect(mainSource).toContain("canonicalizeLegacyFavoriteFolder");
    expect(mainSource).toContain("favoriteVaultMigrationKey");
    expect(mainSource).not.toContain("favoriteFoldersSetting");
    expect(mainSource).not.toContain("favorites.toggle");
    expect(mainSource).not.toContain("createFavoritesSection");
  });

  it("keeps the selected global Explorer root while opening a child document", async () => {
    await import("../src/main");
    await new Promise((resolve) => setTimeout(resolve, 100));

    document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLElement>('[data-vault-id="vault-global"] .workspace-vault-select')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const folder = document.querySelector<HTMLElement>('.explorer-dir[data-path="/A/B"]');
    folder?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector<HTMLElement>('.explorer-file[data-path="/A/B/doc.md"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector(".breadcrumb")?.getAttribute("aria-label")).toBe("현재 폴더 경로: /A");
    expect(invokeMock.mock.calls.filter(([command, args]) => command === "list_dir" && pathArg(args) === "/A").length).toBeGreaterThan(1);
  });

  it("does not let a permanent-vault switch overwrite the closed global root", async () => {
    await import("../src/main");
    await new Promise((resolve) => setTimeout(resolve, 100));

    document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector<HTMLButtonElement>('.explorer-vault-toggle')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLElement>('.workspace-vault-row:not([data-vault-id="vault-global"]) .workspace-vault-select')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector<HTMLElement>('[data-vault-id="vault-global"] .workspace-vault-select')?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector(".breadcrumb")?.getAttribute("aria-label")).toBe("현재 폴더 경로: /A");
    expect(document.querySelector(".workspace-vault-group--temporary")).toBeNull();
  });

  it("keeps Global Vault selected while its Explorer bookmark registers a permanent vault", async () => {
    await import("../src/main");
    await new Promise((resolve) => setTimeout(resolve, 100));

    document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector<HTMLButtonElement>(".explorer-vault-toggle")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('[data-vault-id="vault-global"] .workspace-vault-select')?.getAttribute("aria-current")).toBe("true");
    expect(document.querySelector('.workspace-vault-row:not([data-vault-id="vault-global"])')).not.toBeNull();
  });

  it("preserves the Explorer root only for the selected global vault", async () => {
    const { shouldPreserveGlobalExplorerRoot } = await import("../src/main");

    expect(shouldPreserveGlobalExplorerRoot({ persistenceKind: "global" })).toBe(true);
    expect(shouldPreserveGlobalExplorerRoot({ persistenceKind: "permanent" })).toBe(false);
    expect(shouldPreserveGlobalExplorerRoot(undefined)).toBe(false);
  });

  it("restores transient Global Vault intent after a no-document reload without saving it", async () => {
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP"], currentVaultId: "vault-%2FP", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [{ vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" }],
      currentWorkspaceId: "workspace-default",
    }));
    vi.stubGlobal("location", { search: "?file=/A/B/doc.md&vault=global&root=%2FA%2FB" });

    await import("../src/main");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector(".breadcrumb")?.getAttribute("aria-label")).toBe("현재 폴더 경로: /A/B");
    expect(document.querySelector('[data-vault-id="vault-global"] .workspace-vault-select')?.getAttribute("aria-current")).toBe("true");
    expect(JSON.parse(localStorage.getItem("mermark.workspaceState") ?? "{}").workspaces[0].currentVaultId).toBe("vault-%2FP");
  });

  it("updates the Explorer root when a permanent-vault tab is explicitly selected", async () => {
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP"], currentVaultId: "vault-global", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [{ vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" }],
      currentWorkspaceId: "workspace-default",
    }));
    localStorage.setItem("mermark.vaultTabs.vault-%2FP", JSON.stringify({
      vaultId: "vault-%2FP",
      tabs: [{ tabId: "vault-%2FP-tab-%2FP%2Fdoc.md", path: "/P/doc.md" }],
      activeTabId: "vault-%2FP-tab-%2FP%2Fdoc.md",
    }));
    await import("../src/main");
    await new Promise((resolve) => setTimeout(resolve, 100));

    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLElement>('[data-vault-id="vault-%2FP"] .workspace-vault-select')?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector(".breadcrumb")?.getAttribute("aria-label")).toBe("현재 폴더 경로: /P");
  });
});
