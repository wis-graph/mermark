import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";

const pathArg = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null || !("path" in args) || typeof args.path !== "string") return undefined;
  return args.path;
};

const invokeMock = vi.fn((command: string, args?: unknown): Promise<unknown> => {
  const path = pathArg(args) ?? "";
  if (command === "canonicalize_path") return Promise.resolve(path);
  if (command === "read_file") {
    if (rejectedReads.has(path)) return Promise.reject(new Error("read failed"));
    const deferred = deferredReads.get(path);
    if (deferred) return deferred.promise;
    return Promise.resolve({ text: documentContents.get(path) ?? "# document", mtime: 1 });
  }
  if (command === "write_file" && rejectWrites) return Promise.reject(new Error("write failed"));
  if (command === "list_dir") {
    if (path === "/") return Promise.resolve([{ name: "A", path: "/A", is_dir: true }]);
    if (path === "/A") return Promise.resolve([{ name: "B", path: "/A/B", is_dir: true }, { name: "start.md", path: "/A/start.md", is_dir: false }]);
    if (path === "/A/B") return Promise.resolve([{ name: "doc.md", path: "/A/B/doc.md", is_dir: false }]);
    return Promise.resolve([]);
  }
  if (command === "watch_file") {
    watcherEvents.push(`watch ${path}`);
    const deferred = deferredWatches.get(path);
    if (deferred) return deferred.promise;
    if (rejectWatchPath === path) return Promise.reject(new Error("watch failed"));
    return Promise.resolve();
  }
  if (command === "unwatch_file") {
    watcherEvents.push("unwatch");
    if (rejectUnwatch) return Promise.reject(new Error("unwatch failed"));
    return deferredUnwatch ?? Promise.resolve();
  }
  if (command === "list_files_recursive") return Promise.resolve(scanResult);
  return Promise.resolve(false);
});

const documentContents = new Map<string, string>();
const watcherEvents: string[] = [];
const deferredReads = new Map<string, { readonly promise: Promise<unknown> }>();
const deferredWatches = new Map<string, { readonly promise: Promise<void> }>();
const rejectedReads = new Set<string>();
const eventListeners = new Map<string, Set<(event: { readonly payload: unknown }) => void>>();
let scanResult: unknown = { files: [], truncated: false };
let deferredUnwatch: Promise<void> | undefined;
let rejectWrites = false;
let rejectUnwatch = false;
let rejectWatchPath: string | undefined;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, listener: (event: { readonly payload: unknown }) => void) => {
    const listeners = eventListeners.get(event) ?? new Set();
    listeners.add(listener);
    eventListeners.set(event, listeners);
    return Promise.resolve(() => listeners.delete(listener));
  }),
}));

const emitEvent = (event: string, payload: unknown): void => {
  for (const listener of eventListeners.get(event) ?? []) listener({ payload });
};

const mainSource = readFileSync("src/main.ts", "utf8");

describe("main workspace wiring", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { search: "?file=/A/start.md" });
    localStorage.clear();
    invokeMock.mockClear();
    documentContents.clear();
    watcherEvents.length = 0;
    deferredReads.clear();
    deferredWatches.clear();
    rejectedReads.clear();
    eventListeners.clear();
    scanResult = { files: [], truncated: false };
    deferredUnwatch = undefined;
    rejectWrites = false;
    rejectUnwatch = false;
    rejectWatchPath = undefined;
    const app = document.createElement("div");
    app.id = "app";
    document.body.append(app);
  });

  afterEach(() => {
    document.querySelector("#app")?.remove();
    document.querySelectorAll(".recovery-backdrop, .conflict-backdrop").forEach((element) => element.remove());
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
    expect(mainSource.match(/location\.href = createDocumentReloadUrl/g)).toHaveLength(3);
  });

  it("routes live tab selection and close fallback through main", () => {
    expect(mainSource).toContain("onSelectTab: (vault, tab) => {");
    expect(mainSource).toContain("const selectedVault = workspaceStore.get().vaults.find((candidate) => candidate.vaultId === vault.vaultId) ?? vault;");
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

  it("keeps the active tab and watcher while an inactive tab is still being read", async () => {
    let resolveB: ((value: unknown) => void) | undefined;
    const bRead = new Promise<unknown>((resolve) => { resolveB = resolve; });
    deferredReads.set("/P/b.md", { promise: bRead });
    documentContents.set("/P/a.md", "# A");
    documentContents.set("/P/b.md", "# B");
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP"], currentVaultId: "vault-%2FP", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [{ vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" }],
      currentWorkspaceId: "workspace-default",
    }));
    localStorage.setItem("mermark.vaultTabs.vault-%2FP", JSON.stringify({
      vaultId: "vault-%2FP",
      tabs: [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }],
      activeTabId: "a",
    }));
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("A"));
    watcherEvents.length = 0;
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();

    expect(document.querySelector<HTMLButtonElement>('[data-tab-id="a"]')?.getAttribute("data-active")).toBe("true");
    expect(document.querySelector(".cm-content")?.textContent).toBe("A");
    resolveB?.({ text: "# B", mtime: 2 });
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("B"));

    expect(watcherEvents).toEqual(["unwatch", "watch /P/b.md"]);
    expect(document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.getAttribute("data-active")).toBe("true");
  });

  it("keeps roving focus on the active tab while keyboard activation is pending", async () => {
    let resolveB: ((value: unknown) => void) | undefined;
    deferredReads.set("/P/b.md", { promise: new Promise<unknown>((resolve) => { resolveB = resolve; }) });
    documentContents.set("/P/a.md", "# A");
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP"], currentVaultId: "vault-%2FP", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [{ vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" }],
      currentWorkspaceId: "workspace-default",
    }));
    localStorage.setItem("mermark.vaultTabs.vault-%2FP", JSON.stringify({ vaultId: "vault-%2FP", tabs: [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }], activeTabId: "a" }));
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("A"));
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    const active = document.querySelector<HTMLButtonElement>('[data-tab-id="a"]');
    active?.focus();
    active?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(active?.getAttribute("aria-selected")).toBe("true");
    expect(active?.tabIndex).toBe(0);
    expect(document.activeElement).toBe(active);
    resolveB?.({ text: "# B", mtime: 2 });
  });

  it.each([
    ["ArrowRight", "/P/c.md"],
    ["Home", "/P/a.md"],
    ["End", "/P/c.md"],
  ])("restores focus to the selected tab after rejected %s activation recovery is cancelled", async (key, rejectedPath) => {
    documentContents.set("/P/b.md", "# B");
    rejectedReads.add(rejectedPath);
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP"], currentVaultId: "vault-%2FP", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [{ vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" }],
      currentWorkspaceId: "workspace-default",
    }));
    localStorage.setItem("mermark.vaultTabs.vault-%2FP", JSON.stringify({
      vaultId: "vault-%2FP",
      tabs: [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }, { tabId: "c", path: "/P/c.md" }],
      activeTabId: "b",
    }));
    vi.stubGlobal("location", { search: "?file=/P/b.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("B"));
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    const active = document.querySelector<HTMLButtonElement>('[data-tab-id="b"]');
    active?.focus();
    active?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".recovery-modal")).not.toBeNull());

    expect(active?.getAttribute("aria-selected")).toBe("true");
    expect(active?.tabIndex).toBe(0);
    expect(document.activeElement?.closest(".recovery-modal")).not.toBeNull();
    document.querySelector<HTMLButtonElement>(".recovery-cancel")?.click();

    expect(document.querySelector(".recovery-modal")).toBeNull();
    expect(document.activeElement).toBe(active);
  });

  it("restores the active watcher when a stale B handoff completes after failed C", async () => {
    let resolveWatchB: (() => void) | undefined;
    deferredWatches.set("/P/b.md", { promise: new Promise<void>((resolve) => { resolveWatchB = resolve; }) });
    documentContents.set("/P/a.md", "# A");
    documentContents.set("/P/b.md", "# B");
    documentContents.set("/P/c.md", "# C");
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP"], currentVaultId: "vault-%2FP", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [{ vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" }],
      currentWorkspaceId: "workspace-default",
    }));
    localStorage.setItem("mermark.vaultTabs.vault-%2FP", JSON.stringify({ vaultId: "vault-%2FP", tabs: [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }, { tabId: "c", path: "/P/c.md" }], activeTabId: "a" }));
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("A"));
    watcherEvents.length = 0;
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
    await vi.waitFor(() => expect(watcherEvents).toContain("watch /P/b.md"));
    rejectedReads.add("/P/c.md");
    document.querySelector<HTMLButtonElement>('[data-tab-id="c"]')?.click();
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("A"));
    resolveWatchB?.();
    await vi.waitFor(() => expect(watcherEvents).toContain("watch /P/a.md"));

    expect(document.querySelector('[data-tab-id="a"][data-active="true"]')).not.toBeNull();
    expect(document.querySelector(".cm-content")?.textContent).toBe("A");
    expect(watcherEvents).toEqual(["unwatch", "watch /P/b.md", "watch /P/a.md"]);
  });

  it.each(["Recent", "File Finder"])("keeps a late A watch event away from B when switching through %s", async (surface) => {
    let resolveDetach: (() => void) | undefined;
    documentContents.set("/P/a.md", "# A");
    documentContents.set("/P/b.md", "# B");
    localStorage.setItem("mermark.recentDocs", JSON.stringify(["/P/b.md"]));
    scanResult = { files: [{ name: "b.md", path: "/P/b.md", rel_path: "b.md" }], truncated: false };
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("A"));
    await vi.waitFor(() => expect(watcherEvents).toContain("watch /P/a.md"));
    watcherEvents.length = 0;
    deferredUnwatch = new Promise<void>((resolve) => { resolveDetach = resolve; });

    if (surface === "Recent") {
      document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
      document.querySelector<HTMLElement>('.recent-item[data-path="/P/b.md"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } else {
      document.querySelector<HTMLButtonElement>(".search-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.search-item[data-path="/P/b.md"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.search-item[data-path="/P/b.md"]')?.click();
    }
    await vi.waitFor(() => expect(watcherEvents).toEqual(["unwatch"]));

    expect(document.querySelector(".cm-content")?.textContent).toBe("A");
    emitEvent("file-changed", { text: "# late A", mtime: 2 });
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("late A"));
    resolveDetach?.();
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("B"));
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();

    expect(document.querySelector('.workspace-vault-tab[data-active="true"]')?.getAttribute("title")).toBe("/P/b.md");
    expect(document.querySelector(".cm-content")?.textContent).toBe("B");
    expect(watcherEvents).toEqual(["unwatch", "watch /P/b.md"]);
  });

  it("retains a dirty editor when switching to a vault with no restorable tab fails", async () => {
    documentContents.set("/P/a.md", "# A");
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP", "vault-%2FQ"], currentVaultId: "vault-%2FP", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [
        { vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" },
        { vaultId: "vault-%2FQ", workspaceId: "workspace-default", displayName: "Q", rootPath: "/Q", persistenceKind: "permanent", explorerRoot: "/Q" },
      ],
      currentWorkspaceId: "workspace-default",
    }));
    localStorage.setItem("mermark.vaultTabs.vault-%2FP", JSON.stringify({
      vaultId: "vault-%2FP",
      tabs: [{ tabId: "a", path: "/P/a.md" }],
      activeTabId: "a",
    }));
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("A"));
    const liveEditor = (window as Window & { readonly __mermark?: { readonly view: EditorView } }).__mermark;
    liveEditor?.view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
    rejectWrites = true;
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLButtonElement>('[data-vault-id="vault-%2FQ"] .workspace-vault-select')?.click();
    await vi.waitFor(() => expect(document.querySelector(".recovery-modal")).not.toBeNull());

    expect(document.querySelector(".cm-content")?.textContent).toContain("A");
    expect(document.querySelector('[data-vault-id="vault-%2FP"] .workspace-vault-tab[data-active="true"]')).not.toBeNull();
    expect(document.querySelector('[data-vault-id="vault-%2FQ"] .workspace-vault-select')?.getAttribute("aria-current")).toBe("false");
  });

  it("keeps a dirty final tab mounted when close preparation is cancelled", async () => {
    documentContents.set("/P/a.md", "# A");
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP"], currentVaultId: "vault-%2FP", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [{ vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" }],
      currentWorkspaceId: "workspace-default",
    }));
    localStorage.setItem("mermark.vaultTabs.vault-%2FP", JSON.stringify({
      vaultId: "vault-%2FP",
      tabs: [{ tabId: "a", path: "/P/a.md" }],
      activeTabId: "a",
    }));
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("A"));
    const liveEditor = (window as Window & { readonly __mermark?: { readonly view: EditorView } }).__mermark;
    liveEditor?.view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
    rejectWrites = true;
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLButtonElement>('[data-vault-id="vault-%2FP"] .workspace-vault-tab-close')?.click();
    await vi.waitFor(() => expect(document.querySelector(".recovery-modal")).not.toBeNull());

    expect(document.querySelector('[data-vault-id="vault-%2FP"] .workspace-vault-tab[data-active="true"]')).not.toBeNull();
    expect(document.querySelector(".cm-content")?.textContent).toContain("A");
    document.querySelector<HTMLButtonElement>(".recovery-cancel")?.click();
    expect(document.querySelector(".recovery-modal")).toBeNull();
    expect(document.querySelector('[data-vault-id="vault-%2FP"] .workspace-vault-tab[data-active="true"]')).not.toBeNull();
  });

  it("retains the active tab when detaching the outgoing watcher is rejected", async () => {
    documentContents.set("/P/a.md", "# A");
    documentContents.set("/P/b.md", "# B");
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP"], currentVaultId: "vault-%2FP", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [{ vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" }],
      currentWorkspaceId: "workspace-default",
    }));
    localStorage.setItem("mermark.vaultTabs.vault-%2FP", JSON.stringify({ vaultId: "vault-%2FP", tabs: [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }], activeTabId: "a" }));
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("A"));
    watcherEvents.length = 0;
    rejectUnwatch = true;
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
    await vi.waitFor(() => expect(watcherEvents).toContain("unwatch"));

    expect(document.querySelector('[data-tab-id="a"][data-active="true"]')).not.toBeNull();
    expect(document.querySelector(".cm-content")?.textContent).toBe("A");
    expect(watcherEvents).not.toContain("watch /P/b.md");
    console.info("WATCH_REJECTION_EVENTS", JSON.stringify(watcherEvents));
  });

  it("rolls the watcher back and retains the active tab when attaching the next watcher is rejected", async () => {
    documentContents.set("/P/a.md", "# A");
    documentContents.set("/P/b.md", "# B");
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP"], currentVaultId: "vault-%2FP", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [{ vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" }],
      currentWorkspaceId: "workspace-default",
    }));
    localStorage.setItem("mermark.vaultTabs.vault-%2FP", JSON.stringify({ vaultId: "vault-%2FP", tabs: [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }], activeTabId: "a" }));
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("A"));
    watcherEvents.length = 0;
    rejectWatchPath = "/P/b.md";
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
    await vi.waitFor(() => expect(watcherEvents).toEqual(["unwatch", "watch /P/b.md", "watch /P/a.md"]));

    expect(document.querySelector('[data-tab-id="a"][data-active="true"]')).not.toBeNull();
    expect(document.querySelector(".cm-content")?.textContent).toBe("A");
    console.info("WATCH_ROLLBACK_EVENTS", JSON.stringify(watcherEvents));
  });
});
