import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { SHORTCUT_ACTIONS } from "../src/shortcuts/actions";

const pathArg = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null || !("path" in args) || typeof args.path !== "string") return undefined;
  return args.path;
};

const invokeMock = vi.fn((command: string, args?: unknown): Promise<unknown> => {
  const path = pathArg(args) ?? "";
  // Identity mock (single "." segment collapsed only — never ".." — matching
  // this file's stated contract: it is NOT a real fs::canonicalize, it just
  // lets a literal `./B/doc.md` join (local-doc-link.ts's candidateAbs, which
  // deliberately does not lexically collapse before canonicalizing — design
  // D3) resolve to a stable path for the Phase F happy-path assertion below).
  if (command === "canonicalize_path") return Promise.resolve(path.replace(/\/\.\//g, "/"));
  if (command === "path_exists") return Promise.resolve(pathExistsPaths.has(path));
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
    const session = { path, generation: String(++watcherGeneration) };
    const deferred = deferredWatches.get(path);
    if (deferred) return deferred.promise.then(() => session);
    if (rejectWatchPath === path) return Promise.reject(new Error("watch failed"));
    return Promise.resolve(session);
  }
  if (command === "unwatch_file") {
    watcherEvents.push("unwatch");
    if (rejectUnwatch) return Promise.reject(new Error("unwatch failed"));
    return deferredUnwatch ?? Promise.resolve();
  }
  if (command === "register_window_ready") {
    cliRoutingOrder.push("ready");
    return Promise.resolve(undefined);
  }
  if (command === "acknowledge_open_request") {
    const a = args as Record<string, unknown>;
    cliAcks.push({ id: Number(a.id ?? -1), outcome: String(a.outcome ?? "") });
    return Promise.resolve(undefined);
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
// Phase F (Todo 3 document-open seam): paths that `path_exists` should report
// as present. Empty by default — only the happy-path permanent-vault test
// below populates it, so every other test's implicit "path_exists → false"
// behavior (there is no other consumer of this command in this suite) stays
// unchanged.
const pathExistsPaths = new Set<string>();
let deferredUnwatch: Promise<void> | undefined;
let rejectWrites = false;
let rejectUnwatch = false;
let rejectWatchPath: string | undefined;
let watcherGeneration = 0;

// CLI file-open routing (Todo 2). `cliRoutingOrder` records "listen"/"ready"
// in call order — the listen→register_window_ready sequencing contract is
// only meaningful as an *order* assertion, so this stays a plain push log
// (same pattern as watcherEvents above) rather than relying on vi.fn's
// invocationCallOrder (which mockClear() would disturb between tests).
// `cliAcks` records every acknowledge_open_request invoke in call order —
// the observable proof that a delivered request was retained until the
// frontend surfaced a success or a visible-recovery outcome, never silently
// dropped.
const cliRoutingOrder: string[] = [];
const cliAcks: { id: number; outcome: string }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

const listenMock = vi.fn(
  (event: string, listener: (event: { readonly payload: unknown }) => void, _options?: unknown) => {
    if (event === "cli-open-request") cliRoutingOrder.push("listen");
    const listeners = eventListeners.get(event) ?? new Set();
    listeners.add(listener);
    eventListeners.set(event, listeners);
    return Promise.resolve(() => listeners.delete(listener));
  },
);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, listener: (event: { readonly payload: unknown }) => void, options?: unknown) =>
    listenMock(event, listener, options),
}));

// registerCliOpenRouting() reads getCurrentWindow().label unconditionally (not
// gated behind the "__TAURI_INTERNALS__" check the close-requested wiring
// uses), so this jsdom environment needs a window mock too — same precedent
// as tests/session-persistence.test.ts. label: "main" matches the browser
// mock (src/mocks/tauri-window.ts).
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", onCloseRequested: () => Promise.resolve(() => {}) }),
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
    pathExistsPaths.clear();
    deferredUnwatch = undefined;
    rejectWrites = false;
    rejectUnwatch = false;
    rejectWatchPath = undefined;
    watcherGeneration = 0;
    cliRoutingOrder.length = 0;
    cliAcks.length = 0;
    listenMock.mockClear();
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

  it.each([
    ["Explorer", "/A/start.md"],
    ["Recent", "/P/b.md"],
    ["File Finder", "/P/b.md"],
  ])("reloads from the welcome screen through %s", async (surface, target) => {
    localStorage.setItem("mermark.recentDocs", JSON.stringify(["/P/b.md"]));
    scanResult = { files: [{ name: "b.md", path: "/P/b.md", rel_path: "b.md" }], truncated: false };
    vi.stubGlobal("location", { search: "", href: "" });

    await import("../src/main");

    if (surface === "Explorer") {
      document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-dir[data-path="/A"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.explorer-dir[data-path="/A"]')?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="/A/start.md"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.explorer-file[data-path="/A/start.md"]')?.click();
    } else if (surface === "Recent") {
      document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
      document.querySelector<HTMLElement>('.recent-item[data-path="/P/b.md"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } else {
      document.querySelector<HTMLButtonElement>(".search-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.search-item[data-path="/P/b.md"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.search-item[data-path="/P/b.md"]')?.click();
    }

    const reload = new URL(location.href, "https://mermark.test/");
    expect(reload.pathname).toBe("/index.html");
    expect(reload.searchParams.get("file")).toBe(target);
    expect(reload.searchParams.get("vault")).toBe("global");
    expect(reload.searchParams.get("root")).toBe("/");
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
    emitEvent("file-changed", { path: "/P/a.md", generation: "1", text: "# late A", mtime: 2 });
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("late A"));
    resolveDetach?.();
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("B"));
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();

    expect(document.querySelector('.workspace-vault-tab[data-active="true"]')?.getAttribute("title")).toBe("/P/b.md");
    expect(document.querySelector(".cm-content")?.textContent).toBe("B");
    expect(watcherEvents).toEqual(["unwatch", "watch /P/b.md"]);
  });

  it("rejects delayed A watcher events after a successful handoff to B", async () => {
    documentContents.set("/P/a.md", "# A");
    documentContents.set("/P/b.md", "# B");
    localStorage.setItem("mermark.recentDocs", JSON.stringify(["/P/b.md"]));
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("A"));
    await vi.waitFor(() => expect(watcherEvents).toContain("watch /P/a.md"));
    document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
    document.querySelector<HTMLElement>('.recent-item[data-path="/P/b.md"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("B"));
    await vi.waitFor(() => expect(watcherEvents).toContain("watch /P/b.md"));

    emitEvent("file-changed", { path: "/P/a.md", generation: "1", text: "# stale A", mtime: 2 });
    emitEvent("file-unavailable", { path: "/P/a.md", generation: "1", kind: "deleted", detail: "A 파일이 삭제되었습니다" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector(".cm-content")?.textContent).toBe("B");
    expect(document.querySelector(".recovery-modal")).toBeNull();
  });

  it.each(["Recent", "File Finder"])("keeps A mounted and watched when detaching it is rejected through %s", async (surface) => {
    documentContents.set("/P/a.md", "# A");
    documentContents.set("/P/b.md", "# B");
    localStorage.setItem("mermark.recentDocs", JSON.stringify(["/P/b.md"]));
    scanResult = { files: [{ name: "b.md", path: "/P/b.md", rel_path: "b.md" }], truncated: false };
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("A"));
    watcherEvents.length = 0;
    rejectUnwatch = true;

    if (surface === "Recent") {
      document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
      document.querySelector<HTMLElement>('.recent-item[data-path="/P/b.md"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } else {
      document.querySelector<HTMLButtonElement>(".search-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.search-item[data-path="/P/b.md"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.search-item[data-path="/P/b.md"]')?.click();
    }
    await vi.waitFor(() => expect(watcherEvents).toEqual(["unwatch"]));

    emitEvent("file-changed", { path: "/P/a.md", generation: "1", text: "# late A", mtime: 2 });
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("late A"));

    expect(document.querySelector('.workspace-vault-tab[data-active="true"]')?.getAttribute("title")).toBe("/P/a.md");
    expect(watcherEvents).toEqual(["unwatch"]);
    expect(watcherEvents).not.toContain("watch /P/b.md");
  });

  it("keeps an unavailable recent entry visible so the user can retry it", async () => {
    documentContents.set("/P/a.md", "# A");
    localStorage.setItem("mermark.recentDocs", JSON.stringify(["/P/missing.md"]));
    rejectedReads.add("/P/missing.md");
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("A"));
    document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
    document.querySelector<HTMLElement>('.recent-item[data-path="/P/missing.md"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".recovery-modal")).not.toBeNull());

    document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
    expect(document.querySelector('.recent-item[data-path="/P/missing.md"]')).not.toBeNull();
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

  // CLI file-open routing (single-window-opening Todo 2): the backend's
  // single-instance broker delivers a second `mermark <file>` process's
  // request as a "cli-open-request" event once this webview registers ready,
  // and retains the request until acknowledged. These four tests cover the
  // frontend's half of that contract (design §분기3).

  it("registers the cli-open-request listener before announcing window readiness", async () => {
    await import("../src/main");
    await vi.waitFor(() => expect(cliRoutingOrder).toContain("ready"));

    // Not just "both happened" — listen must complete before register_window_ready
    // is invoked, or a request the backend delivers right after seeing "ready"
    // would be emitted into a webview with no listener yet (design §분기3 순서 계약).
    expect(cliRoutingOrder).toEqual(["listen", "ready"]);
  });

  it("opens a delivered cli-open-request and acknowledges it as opened", async () => {
    documentContents.set("/A/other.md", "# other");
    await import("../src/main");
    await vi.waitFor(() => expect(cliRoutingOrder).toContain("ready"));

    emitEvent("cli-open-request", { id: 7, path: "/A/other.md" });

    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("other"));
    expect(cliAcks).toEqual([{ id: 7, outcome: "opened" }]);
  });

  it("acknowledges a cli-open-request as recovered (not silently) when a dirty commit fails", async () => {
    documentContents.set("/A/start.md", "# start");
    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("start"));
    await vi.waitFor(() => expect(cliRoutingOrder).toContain("ready"));

    const liveEditor = (window as Window & { readonly __mermark?: { readonly view: EditorView } }).__mermark;
    liveEditor?.view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
    rejectWrites = true;

    emitEvent("cli-open-request", { id: 9, path: "/A/other.md" });

    await vi.waitFor(() => expect(cliAcks).toEqual([{ id: 9, outcome: "recovered" }]));
    // The failed/cancelled safe-open must not vanish from view either — the
    // still-dirty document stays mounted, visibly, rather than being
    // silently swapped out from under the ack.
    expect(document.querySelector(".cm-content")?.textContent).toContain("start");
  });

  it("acknowledges rapid double cli-open-requests in FIFO id order", async () => {
    documentContents.set("/A/one.md", "# One");
    documentContents.set("/A/two.md", "# Two");
    await import("../src/main");
    await vi.waitFor(() => expect(cliRoutingOrder).toContain("ready"));

    emitEvent("cli-open-request", { id: 1, path: "/A/one.md" });
    emitEvent("cli-open-request", { id: 2, path: "/A/two.md" });

    await vi.waitFor(() => expect(cliAcks.map((ack) => ack.id)).toEqual([1, 2]));
    // The second request supersedes the in-flight first one (one editor, one
    // active lifecycle request) — id 1 resolves as a visible non-open outcome,
    // id 2 lands. Ack *order* (id ascending) is the FIFO contract under test;
    // outcome values follow from the existing single-editor supersede rule.
    expect(cliAcks).toEqual([
      { id: 1, outcome: "recovered" },
      { id: 2, outcome: "opened" },
    ]);
    expect(document.querySelector(".cm-content")?.textContent).toBe("Two");
  });

  // Document-open seam wiring (single-window-opening Todo 3, Phase F): the
  // seam itself (document-open.ts/local-doc-link.ts) and its callers
  // (wikilink.ts/features/link.ts) are covered by their own test files —
  // this suite only proves the wiring exists and actually reaches
  // openDocumentSafely at runtime, closing the gap a prior session left
  // (setDocumentOpenHandler had no caller, so requestDocumentOpen was a
  // silent no-op end to end).
  describe("document-open seam wiring", () => {
    it("wires setDocumentOpenHandler to openDocumentSafely and openStandardLocalLink", () => {
      expect(mainSource).toContain("setDocumentOpenHandler((request) => {");
      expect(mainSource).toContain("openStandardLocalLink(request, context, openDocumentSafely)");
    });

    it("opens a resolved-document seam request through openDocumentSafely (read_file)", async () => {
      documentContents.set("/A/B/doc.md", "# doc");
      await import("../src/main");
      await vi.waitFor(() => expect(cliRoutingOrder).toContain("ready"));
      const { requestDocumentOpen } = await import("../src/markdown/document-open");
      invokeMock.mockClear();

      requestDocumentOpen({ kind: "resolved-document", path: "/A/B/doc.md" });

      await vi.waitFor(() =>
        expect(invokeMock.mock.calls.some(([command, args]) => command === "read_file" && pathArg(args) === "/A/B/doc.md")).toBe(true),
      );
    });

    it("rejects a standard-link seam request with no-vault-context in the default (global-vault) boot state", async () => {
      await import("../src/main");
      await vi.waitFor(() => expect(cliRoutingOrder).toContain("ready"));
      const { requestDocumentOpen } = await import("../src/markdown/document-open");
      invokeMock.mockClear();
      const feedbackEl = document.createElement("a");

      requestDocumentOpen({ kind: "standard-link", href: "./x.md", feedbackEl });
      await vi.waitFor(() => expect(feedbackEl.title).toBe("영구 볼트의 문서에서만 로컬 링크를 열 수 있습니다"));

      expect(invokeMock.mock.calls.some(([command]) => command === "read_file")).toBe(false);
    });

    it("opens a standard-link seam request through the validation pipeline in a permanent vault", async () => {
      localStorage.setItem("mermark.workspaceState", JSON.stringify({
        workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FA"], currentVaultId: "vault-%2FA", lastSelectedPermanentVaultId: "vault-%2FA" }],
        vaults: [{ vaultId: "vault-%2FA", workspaceId: "workspace-default", displayName: "A", rootPath: "/A", persistenceKind: "permanent", explorerRoot: "/A" }],
        currentWorkspaceId: "workspace-default",
      }));
      documentContents.set("/A/start.md", "# start");
      documentContents.set("/A/B/doc.md", "# doc");
      pathExistsPaths.add("/A/start.md");
      pathExistsPaths.add("/A/B/doc.md");

      await import("../src/main");
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("start"));
      const { requestDocumentOpen } = await import("../src/markdown/document-open");
      invokeMock.mockClear();
      const feedbackEl = document.createElement("a");

      requestDocumentOpen({ kind: "standard-link", href: "./B/doc.md", feedbackEl });

      await vi.waitFor(() =>
        expect(invokeMock.mock.calls.some(([command, args]) => command === "read_file" && pathArg(args) === "/A/B/doc.md")).toBe(true),
      );
      expect(feedbackEl.title).toBe("");
    });
  });

  // Vault image attachment action wiring (`vault:` scheme withdrawal —
  // _workspace/00_request_vaultimage_fix.md): image.attach's orchestration
  // itself (vaultRoot/cancel/insert/rollback) is covered end-to-end by
  // tests/attach-image.test.ts's DI-based attachImageToVault suite — this
  // only proves the catalog entry exists and main.ts actually registers a
  // handler wired to it (the gap the CLI-routing header comment above warns
  // about: a handler with no registration is a silent no-op).
  describe("vault image attachment action wiring", () => {
    it("lists image.attach in the shortcut catalog, unbound by default", () => {
      const action = SHORTCUT_ACTIONS.find((a) => a.id === "image.attach");
      expect(action).toEqual({ id: "image.attach", label: "이미지 첨부", defaultBinding: null });
    });

    it("registers a handler for image.attach wired to attachImageToVault", () => {
      expect(mainSource).toContain('registerHandler("image.attach", () => {');
      expect(mainSource).toContain("void attachImageToVault({");
      expect(mainSource).toContain("vaultRoot: currentOwningVaultRoot(),");
    });

    it("wires setImageSearchRoot from the document's OWNING vault root at boot (never the active vault)", () => {
      expect(mainSource).toContain("setImageSearchRoot(currentOwningVaultRoot);");
      expect(mainSource).toContain(
        "owningVaultRoot(dirOf(currentFile), permanentRootsOf(workspaceStore.get())) : null;",
      );
    });
  });
});
