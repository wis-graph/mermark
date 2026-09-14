import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { SHORTCUT_ACTIONS } from "../src/shortcuts/actions";
import { REMOTE_VAULT_WIRE_ROOT } from "../src/workspace/workspace-state";

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
  // `~` is the one deliberate exception: `resolveHomeRoot` (src/main.ts) now
  // rejects any canonicalize_path("~") result that isn't itself absolute (the
  // Windows-home fix), so an identity "~" → "~" would be discarded as the
  // unresolvable-home case and this mock would stop exercising the "home
  // resolved successfully" path it's meant to. Standing in for a real home
  // dir here — "/home/mock-user" — both satisfies that guard AND still
  // renders as the compact "~" breadcrumb label below, via the same
  // abbreviateHome() rule (document/path.ts) a real "/home/<user>" would hit.
  if (command === "canonicalize_path") {
    if (path === "~") return Promise.resolve("/home/mock-user");
    return Promise.resolve(path.replace(/\/\.\//g, "/"));
  }
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
  // task 10: a paired remote vault's reads go through remote_list_dir/
  // remote_read_file (file-host.ts's remoteFileHost) instead of the local
  // commands above — wired here so the "drive onSelectTab with a real
  // RemoteVault" integration test below exercises the real Explorer +
  // workspace-sidebar click path, not just a spied fileHostFor call.
  if (command === "remote_list_dir") {
    const a = args as Record<string, unknown>;
    const remotePath = String(a.path ?? "");
    // C1 regression guard: the real host (remote_host.rs's `safe_path`)
    // treats ONLY the empty string as "the vault root" — a leading "/" 404s
    // at `resolve_within`'s `RootDir` rejection, which `remote_client.rs`'s
    // `classify()` maps to `REMOTE:SharingOff`. A caller that still sends
    // "/" for the root (the exact C1 bug) sees this rejection here too,
    // instead of the mock silently answering as if "/" worked.
    if (remotePath.startsWith("/")) return Promise.reject(new Error("REMOTE:SharingOff"));
    // "책.epub" (task 11): a remote vault CAN list a non-viewable file — the
    // listing itself is just names/paths — but opening it must be refused
    // (remote-capability.ts's remoteCanOpen), not silently mis-rendered.
    if (remotePath === REMOTE_VAULT_WIRE_ROOT) {
      return Promise.resolve([
        { name: "노트.md", path: "노트.md", is_dir: false },
        { name: "책.epub", path: "책.epub", is_dir: false },
      ]);
    }
    return Promise.resolve([]);
  }
  if (command === "remote_read_file") {
    const a = args as Record<string, unknown>;
    const remotePath = String(a.path ?? "");
    // Same C1 regression guard as remote_list_dir above, applied to reads —
    // a vault-relative name never starts with "/" on the wire.
    if (remotePath.startsWith("/")) return Promise.reject(new Error("REMOTE:SharingOff"));
    return Promise.resolve({ text: documentContents.get(remotePath) ?? "# 원격 문서", mtime: 1 });
  }
  if (command === "remote_read_image") {
    const a = args as Record<string, unknown>;
    const remotePath = String(a.path ?? "");
    remoteReadImageCalls.push(remotePath);
    // Same C1 regression guard: a root-level document's image reference must
    // resolve to a bare vault-relative name ("pic.png"), never "/pic.png" —
    // main.ts's currentBaseDir fallback for a root-level remote document must
    // be the wire root (""), not the local filesystem root ("/").
    if (remotePath.startsWith("/")) return Promise.reject(new Error("REMOTE:SharingOff"));
    return Promise.resolve("data:image/png;base64,AAAA");
  }
  return Promise.resolve(false);
});

const documentContents = new Map<string, string>();
const remoteReadImageCalls: string[] = [];
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
  // The built-in image viewer (exercised by the viewer-vs-document CLI
  // tests below) resolves a local path's src through convertFileSrc —
  // stubbed identically to the browser mock (src/mocks/tauri-core.ts) so
  // those tests don't need their own asset-protocol double.
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
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
    remoteReadImageCalls.length = 0;
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

    // `.explorer-btn` alone already opens on "/A" — the beforeEach's
    // `?file=/A/start.md` routes here at boot, before any vault click. A
    // reclick of the already-active Global Vault row is deliberately NOT
    // exercised here anymore: since 00_request.md #2, that click always jumps
    // to HOME (see "jumps the global vault to the resolved home directory"
    // above), so it would defeat this test's actual point — that folder
    // navigation + opening a document never drifts the root away from where
    // it already was.
    document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const folder = document.querySelector<HTMLElement>('.explorer-dir[data-path="/A/B"]');
    folder?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector<HTMLElement>('.explorer-file[data-path="/A/B/doc.md"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector(".breadcrumb")?.getAttribute("aria-label")).toBe("현재 폴더 경로: /A");
    // list_dir("/A") fires at least once (the boot-time open of the root) —
    // the original ">1" bound counted a second call from a global-vault
    // reclick this test no longer performs (see comment above).
    expect(invokeMock.mock.calls.filter(([command, args]) => command === "list_dir" && pathArg(args) === "/A").length).toBeGreaterThanOrEqual(1);
  });

  // 2026-08-25 regression: opening a document that lives inside an already-
  // EXPANDED folder used to unconditionally reset the tree (main.ts's old
  // unconditional `explorer.resetToBaseDir()` in openInWindow), collapsing
  // every folder back to `aria-expanded="false"` even though the tree's root
  // never actually changed. syncExplorerToOpenedDocument's `showsFolderOf`
  // branch is what's supposed to leave the tree alone here.
  it("does not collapse an already-expanded folder when opening a document inside it (regression)", async () => {
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FA"], currentVaultId: "vault-%2FA", lastSelectedPermanentVaultId: "vault-%2FA" }],
      vaults: [{ vaultId: "vault-%2FA", workspaceId: "workspace-default", displayName: "A", rootPath: "/A", persistenceKind: "permanent", explorerRoot: "/A" }],
      currentWorkspaceId: "workspace-default",
    }));
    documentContents.set("/A/start.md", "# start");
    documentContents.set("/A/B/doc.md", "# doc");

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("start"));

    document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
    await vi.waitFor(() => expect(document.querySelector('.explorer-dir[data-path="/A/B"]')).not.toBeNull());
    document.querySelector<HTMLElement>('.explorer-dir[data-path="/A/B"]')?.click();
    await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="/A/B/doc.md"]')).not.toBeNull());

    const listDirCallsForB = () => invokeMock.mock.calls.filter(([command, args]) => command === "list_dir" && pathArg(args) === "/A/B").length;
    expect(listDirCallsForB()).toBe(1); // one read to populate the folder

    document.querySelector<HTMLElement>('.explorer-file[data-path="/A/B/doc.md"]')?.click();
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("doc"));

    // The folder that CONTAINS the just-opened document must still be expanded
    // — the tree was never touched, so `expandFolder`'s aria-expanded write
    // survives verbatim.
    expect(document.querySelector('.explorer-dir[data-path="/A/B"]')?.getAttribute("aria-expanded")).toBe("true");
    // childrenCache was preserved (no reset), so /A/B was never re-read.
    expect(listDirCallsForB()).toBe(1);
    // The tree's root is unchanged (still the vault root) and the breadcrumb
    // tracks it, not a re-seeded document-folder root.
    expect(document.querySelector(".breadcrumb")?.getAttribute("aria-label")).toBe("현재 폴더 경로: /A");
    // The newly-opened document is highlighted as the active row.
    expect(document.querySelector('.explorer-file[data-path="/A/B/doc.md"]')?.classList.contains("is-selected")).toBe(true);
  });

  // 00_request.md #2 supersedes this test's original premise: the Global
  // Vault no longer HAS a "closed root" to protect — every entry is a fixed
  // jump to home, never a remembered position — so switching to a permanent
  // vault and back now deterministically lands on home instead of wherever
  // the explorer happened to be before the switch. Kept (renamed) to still
  // guard the other half of its original intent: a permanent-vault switch
  // must not leave a stray temporary vault group behind.
  it("returns to the resolved home root (not a remembered one) after a permanent-vault switch, without leaving a stray temporary group", async () => {
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

    expect(document.querySelector(".breadcrumb")?.getAttribute("aria-label")).toBe("현재 폴더 경로: /home/mock-user");
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

  // task-2b (Ruling 5 follow-up): widening `Vault` with `RemoteVault` only
  // made `tsc` flag ONE hand-rolled ternary (`explorerRootForVault`) — every
  // other vault-kind branch in main.ts was `=== "permanent"` / `=== "global"`,
  // so a remote vault silently fell into the local-vault `else`. These three
  // pure functions replace those ternaries with exhaustive switches
  // (`default: assertNever(vault)`) and pin every vault kind's expected value
  // so the NEXT new vault kind fails `tsc` at all of these sites, not just one.
  it("locks the Explorer root for permanent and remote vaults, not global or no vault", async () => {
    const { isVaultRootLocked } = await import("../src/main");

    expect(isVaultRootLocked({ persistenceKind: "permanent" })).toBe(true);
    expect(isVaultRootLocked({ persistenceKind: "remote" })).toBe(true);
    expect(isVaultRootLocked({ persistenceKind: "global" })).toBe(false);
    expect(isVaultRootLocked(undefined)).toBe(false);
  });

  it("scopes remote vault tabs to the session, same as global, never persisted like permanent", async () => {
    const { tabScopeForVault } = await import("../src/main");

    expect(tabScopeForVault({ persistenceKind: "permanent" })).toBe("permanent");
    expect(tabScopeForVault({ persistenceKind: "global" })).toBe("session");
    expect(tabScopeForVault({ persistenceKind: "remote" })).toBe("session");
  });

  // Windows-home fix regression lock: when the backend can't resolve a home
  // directory (real-world case: expand_home's HOME-only home_dir() on a
  // Windows session — see src-tauri/src/commands.rs), canonicalize_path("~")
  // used to come back as the literal, non-absolute "~" instead of erroring,
  // and that got promoted straight to the explorer's root. resolveHomeRoot
  // must demote ANY non-absolute result to `fallback`, not just a thrown
  // error — this is what actually closes the reported bug.
  it("falls back to the safe root when canonicalize_path resolves home to a non-absolute value", async () => {
    const { resolveHomeRoot } = await import("../src/main");

    await expect(resolveHomeRoot(async () => "~", "/")).resolves.toBe("/");
    await expect(resolveHomeRoot(async () => "notes", "/")).resolves.toBe("/");
    await expect(resolveHomeRoot(async () => "", "/")).resolves.toBe("/");
  });

  it("uses the resolved home when canonicalize_path returns a real absolute path", async () => {
    const { resolveHomeRoot } = await import("../src/main");

    await expect(resolveHomeRoot(async () => "/home/tester", "/")).resolves.toBe("/home/tester");
    await expect(resolveHomeRoot(async () => "C:\\Users\\tester", "/")).resolves.toBe("C:\\Users\\tester");
  });

  it("falls back to the safe root when canonicalize_path rejects", async () => {
    const { resolveHomeRoot } = await import("../src/main");

    await expect(
      resolveHomeRoot(async () => {
        throw new Error("cannot canonicalize");
      }, "/"),
    ).resolves.toBe("/");
  });

  // 00_request.md #2: clicking the global vault always lands the Explorer on
  // the user's HOME directory, not wherever the explorer happened to be
  // sitting (`currentExplorerFolder`) — that varied click to click and was
  // the bug. Resolved via the EXISTING `canonicalize_path` IPC surface (also
  // used by CLI routing above) fed the literal `~`, which `expand_home`
  // (src-tauri) already treats as home — no new backend command. This test's
  // `canonicalize_path` mock returns a stand-in absolute home ("/home/mock-user",
  // see invokeMock above) for "~" specifically, since `resolveHomeRoot` now
  // discards a non-absolute result; the assertion only needs to show the
  // result is NOT `currentExplorerFolder`'s prior value ("/"), i.e. the fixed
  // home path was actually asked for and used, not the stale wander-root.
  it("jumps the global vault to the resolved home directory, not the last explorer folder", async () => {
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP"], currentVaultId: "vault-%2FP", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [{ vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" }],
      currentWorkspaceId: "workspace-default",
    }));
    await import("../src/main");
    await new Promise((resolve) => setTimeout(resolve, 100));

    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLElement>('[data-vault-id="vault-global"] .workspace-vault-select')?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector(".breadcrumb")?.getAttribute("aria-label")).toBe("현재 폴더 경로: /home/mock-user");
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

  // Vault-name click = enter the vault = Explorer opens (2026-08-17 fix): the
  // breadcrumb-only assertion above is not proof the Explorer panel is
  // actually visible — breadcrumb.render runs unconditionally inside
  // openInWindow regardless of whether the panel is open, so it stayed green
  // through the whole regression. These three tests lock the panel's actual
  // `hidden` state across all three onSelectVault branches so they can never
  // drift apart again: a vault with an open tab (the branch that was missing
  // explorer.jumpToRoot), a vault with no tabs (the welcome branch, already
  // correct), and re-clicking the already-active vault+doc (the synchronous
  // same-doc branch, already correct).
  it("opens the Explorer for a name click on a permanent vault THAT HAS an open tab (the fixed branch)", async () => {
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

    expect(document.querySelector<HTMLElement>(".explorer-aside")?.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLElement>('[data-vault-id="vault-%2FP"] .workspace-vault-select')?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector<HTMLElement>(".explorer-aside")?.hidden).toBe(false);
    // Panel mutual exclusion is the intended side effect of opening the
    // Explorer from the Workspace panel, not a bug to guard against.
    expect(document.querySelector<HTMLElement>(".workspace-aside")?.hidden).toBe(true);
    // REVEAL-FOLLOWS-FOCUS obligation succession (2026-08-17 follow-up): this
    // branch's jumpToRoot call races openInWindow's resetToBaseDir (same
    // synchronous tick, same target root) — without the succession fix, the
    // reveal's own render loses that race and its focus obligation is
    // discarded with it, dropping focus to <body> (the .workspace-vault-select
    // button that was clicked no longer exists either, since selecting it
    // re-rendered the whole workspace panel). Real click, not `.focus()` —
    // scripted focus doesn't reliably reproduce the same browser focus-move
    // path a click does.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest(".explorer-aside")).not.toBeNull();
  });

  it("opens the Explorer for a name click on a permanent vault with no open tabs (welcome branch)", async () => {
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FQ"], currentVaultId: "vault-global", lastSelectedPermanentVaultId: "vault-%2FQ" }],
      vaults: [{ vaultId: "vault-%2FQ", workspaceId: "workspace-default", displayName: "Q", rootPath: "/Q", persistenceKind: "permanent", explorerRoot: "/Q" }],
      currentWorkspaceId: "workspace-default",
    }));
    // No mermark.vaultTabs.vault-%2FQ entry at all — VaultTabStore.get()
    // defaults to an empty tab list, so selectVaultView reports "welcome".
    await import("../src/main");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector<HTMLElement>(".explorer-aside")?.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    document.querySelector<HTMLElement>('[data-vault-id="vault-%2FQ"] .workspace-vault-select')?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector<HTMLElement>(".explorer-aside")?.hidden).toBe(false);
    expect(document.querySelector(".breadcrumb")?.getAttribute("aria-label")).toBe("현재 폴더 경로: /Q");
    // Regression guard: this branch never raced resetToBaseDir (no document
    // opens on a welcome-branch entry), so it was never broken — but the
    // succession fix above must not change its outcome either.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest(".explorer-aside")).not.toBeNull();
  });

  it("opens the Explorer on a re-click of the already-active vault+document (synchronous same-doc branch)", async () => {
    documentContents.set("/P/a.md", "# A");
    localStorage.setItem("mermark.workspaceState", JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP"], currentVaultId: "vault-%2FP", lastSelectedPermanentVaultId: "vault-%2FP" }],
      vaults: [{ vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" }],
      currentWorkspaceId: "workspace-default",
    }));
    localStorage.setItem("mermark.vaultTabs.vault-%2FP", JSON.stringify({ vaultId: "vault-%2FP", tabs: [{ tabId: "a", path: "/P/a.md" }], activeTabId: "a" }));
    vi.stubGlobal("location", { search: "?file=/P/a.md" });

    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("A"));

    expect(document.querySelector<HTMLElement>(".explorer-aside")?.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
    // Already the active vault AND already the open document — this is the
    // `commitSelection()` (no openDocumentSafely) branch.
    document.querySelector<HTMLElement>('[data-vault-id="vault-%2FP"] .workspace-vault-select')?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector<HTMLElement>(".explorer-aside")?.hidden).toBe(false);
    expect(document.querySelector(".breadcrumb")?.getAttribute("aria-label")).toBe("현재 폴더 경로: /P");
    // Regression guard: this branch never opens a document (same vault, same
    // doc), so resetToBaseDir never fires alongside it — was never broken,
    // must stay that way.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest(".explorer-aside")).not.toBeNull();
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

  // Viewer-vs-document unification (사용자 리포트 2026-08-17): the CLI cold
  // launch and the cli-open-request listener used to skip the viewer
  // registry entirely and hand every path straight to the text-document
  // path, so `mermark foo.pdf` (or a routed `mermark foo.pdf` into an
  // already-open window) failed trying to read the file as UTF-8 text — the
  // very same file opened fine from the Explorer. Both now funnel through
  // `openPathEntry`, the single viewer-vs-document judgment every
  // path-opening entry point shares. `.png` exercises the built-in image
  // viewer (registered unconditionally at boot), so no extra viewer setup
  // is needed to prove the routing.
  it("opens a viewer-claimed CLI cold launch through the viewer, never as a text document", async () => {
    vi.stubGlobal("location", { search: "?file=/A/pic.png" });

    await import("../src/main");

    await vi.waitFor(() => expect(document.querySelector(".viewer-panel")).not.toBeNull());
    expect(invokeMock.mock.calls.some(([command, args]) => command === "read_file" && pathArg(args) === "/A/pic.png")).toBe(false);
  });

  it("opens a viewer-claimed cli-open-request through the viewer and acknowledges it as opened", async () => {
    documentContents.set("/A/start.md", "# start");
    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("start"));
    await vi.waitFor(() => expect(cliRoutingOrder).toContain("ready"));
    invokeMock.mockClear();

    emitEvent("cli-open-request", { id: 11, path: "/A/pic.png" });

    await vi.waitFor(() => expect(document.querySelector(".viewer-panel")).not.toBeNull());
    await vi.waitFor(() => expect(cliAcks).toEqual([{ id: 11, outcome: "opened" }]));
    expect(invokeMock.mock.calls.some(([command, args]) => command === "read_file" && pathArg(args) === "/A/pic.png")).toBe(false);
    // The viewer occupies its own slot rather than replacing the document —
    // no unsaved-work guard runs on this branch, and the document behind it
    // stays mounted untouched.
    expect(document.querySelector(".cm-content")?.textContent).toBe("start");
  });

  it("still opens a markdown CLI cold launch as a document, not a viewer (regression guard)", async () => {
    documentContents.set("/A/start.md", "# start");
    await import("../src/main");

    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("start"));
    expect(document.querySelector(".viewer-panel")).toBeNull();
    expect(invokeMock.mock.calls.some(([command, args]) => command === "read_file" && pathArg(args) === "/A/start.md")).toBe(true);
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
  // Sidebar toggle shortcuts (⌘1..⌘4 for workspace/explorer/recent/outline —
  // fixed to the action id, not the panel's runtime registration index; see
  // actions.ts's comment on why). Only the panels that had no default before
  // this change (workspace/recent/outline) gained one — explorer keeps ⌘B
  // and doesn't get a second chord here (that's a separate, pending decision).
  describe("sidebar panel toggle shortcuts", () => {
    it("gives workspace/recent/outline default number chords, keeps explorer on Mod+B", () => {
      const byId = (id: string) => SHORTCUT_ACTIONS.find((a) => a.id === id);
      expect(byId("workspace.toggle")).toEqual({ id: "workspace.toggle", label: "워크스페이스", defaultBinding: "Mod+1" });
      expect(byId("explorer.toggle")?.defaultBinding).toBe("Mod+B");
      expect(byId("recent.toggle")?.defaultBinding).toBe("Mod+3");
      expect(byId("outline.toggle")?.defaultBinding).toBe("Mod+4");
    });

    it("registers a handler for workspace.toggle wired to the workspace sidebar button", () => {
      expect(mainSource).toContain('registerHandler("workspace.toggle", () => workspaceSidebar.button.click());');
    });
  });

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

  // task-8a (Ruling 9/10): vault attribution for opening/history/standard
  // links. main.ts extracts each fix's actual DECISION as a small top-level
  // pure function (routingTrustsCurrentVault / resolveTargetVault /
  // standardLinkRejectionFor) — the exact same pattern this file already
  // uses for isVaultRootLocked/tabScopeForVault above — so it can be called
  // directly with a REAL RemoteVault object and asserted on for real,
  // instead of only pinning main.ts's source text (which can't fail for a
  // genuine logic regression that happens to keep the same strings). Task 10
  // closed the gap this comment used to describe (RemoteVault now round-trips
  // through the localStorage deserializer, workspace-state.ts's Ruling 21) —
  // "onSelectTab driven end-to-end with a live RemoteVault" is now covered
  // directly below instead of deferred; the leaf-module behavior itself
  // (wikilink.ts/image.ts honoring a real remote facet value) is separately
  // covered end-to-end by tests/wikilink.test.ts's "remote-vault read-only
  // guard" and tests/image.test.ts's "remote-vault loading" suites. A thin
  // wiring check confirms main.ts's call sites actually USE these functions
  // (a fact no pure-function test can prove on its own).
  describe("task-8a: vault attribution for open/history/standard-links (Ruling 9/10)", () => {
    const permanentVault = { vaultId: "vault-P", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent" as const, explorerRoot: "/P" };
    const globalVault = { vaultId: "vault-global", workspaceId: "workspace-default", displayName: "글로벌 볼트", rootPath: null, persistenceKind: "global" as const, explorerRoot: null };
    const remoteVault = { vaultId: "vault-remote-1", workspaceId: "workspace-default", displayName: "원격 볼트", rootPath: null, persistenceKind: "remote" as const, explorerRoot: REMOTE_VAULT_WIRE_ROOT, host: "wis-macmini", remoteVaultId: "rv-1" };

    it("routingTrustsCurrentVault: true for global/remote (never re-derive by path), false for permanent (path re-derivation is meaningful) and undefined", async () => {
      const { routingTrustsCurrentVault } = await import("../src/main");
      expect(routingTrustsCurrentVault("global")).toBe(true);
      expect(routingTrustsCurrentVault("remote")).toBe(true);
      expect(routingTrustsCurrentVault("permanent")).toBe(false);
      expect(routingTrustsCurrentVault(undefined)).toBe(false);
    });

    it("resolveTargetVault: an explicit target wins over the fallback (the exact bug — reading through the switch's SOURCE vault)", async () => {
      const { resolveTargetVault } = await import("../src/main");
      // The core of the Ruling 9 fix: switching FROM permanentVault TO
      // remoteVault must read through remoteVault, not permanentVault.
      expect(resolveTargetVault(remoteVault, permanentVault, globalVault)).toBe(remoteVault);
      // No explicit target (every non-vault-crossing caller) falls back to
      // whatever is currently open — unchanged pre-existing behavior.
      expect(resolveTargetVault(undefined, permanentVault, globalVault)).toBe(permanentVault);
      // Neither known (e.g. a history entry whose vault was unregistered) —
      // falls all the way back to the Global Vault, never throws/undefined.
      expect(resolveTargetVault(undefined, undefined, globalVault)).toBe(globalVault);
    });

    it("standardLinkRejectionFor: a remote vault always rejects with the exact Korean message; permanent/global/undefined defer to the pipeline (null)", async () => {
      const { standardLinkRejectionFor } = await import("../src/main");
      expect(standardLinkRejectionFor(remoteVault)).toBe("원격 볼트에서는 지원하지 않습니다");
      expect(standardLinkRejectionFor(permanentVault)).toBeNull();
      expect(standardLinkRejectionFor(globalVault)).toBeNull();
      expect(standardLinkRejectionFor(undefined)).toBeNull();
    });

    it("wires routeDocumentPath/openDocument/navigateHistory to actually USE routingTrustsCurrentVault/resolveTargetVault (not a parallel inline copy of the same rule)", () => {
      expect(mainSource).toContain("if (current && routingTrustsCurrentVault(current.persistenceKind)) return current;");
      expect(mainSource).toContain("const readVault = resolveTargetVault(targetVault, currentVault(), workspaceStore.getGlobalVault());");
      expect(mainSource).toContain("fileHostFor(readVault).readFile(absPath);");
      expect(mainSource).toContain("resolveTargetVault(workspaceStore.getVault(entry.vaultId), currentVault(), workspaceStore.getGlobalVault());");
      expect(mainSource).toContain("openInWindow(absPath, fresh, {}, targetVault);");
      expect(mainSource).toContain("openInWindow(target, fresh, { viaHistory: true }, targetVault);");
      // C2: the SAME vault resolved for the read is what handoff uses to
      // decide whether to watch at all (shouldWatchDocument) — not
      // re-derived, and not skipped.
      expect(mainSource).toContain("watcherHandoff.handoff(absPath, readVault)");
      expect(mainSource).toContain("watcherHandoff.handoff(target, targetVault)");
    });

    it("onSelectVault/onSelectTab pass their own already-known target vault through, not the sidebar's currentVault()", () => {
      expect(mainSource).toContain("openDocumentSafely(selection.tab.path, commitSelection, selectedVault)");
      expect(mainSource).toContain("}, selectedVault);");
    });

    it("openInWindow throws rather than silently mounting a document with no vault, and passes the resolved vault into mountEditor's documentVault facet", () => {
      expect(mainSource).toContain('if (!selectedVault) throw new Error(`openInWindow: no vault resolved for "${file}"`);');
      expect(mainSource).toContain("vault: selectedVault,");
    });

    it("wires setDocumentOpenHandler to standardLinkRejectionFor BEFORE building a canonicalize_path context", () => {
      expect(mainSource).toContain("const rejection = standardLinkRejectionFor(vault);");
      expect(mainSource).toContain("markLocalLinkFailure(request.feedbackEl, rejection);");
    });

    // Task 10 (Ruling 21's "파생 효과"): now that a RemoteVault round-trips
    // through localStorage, this drives the REAL boot — Explorer navigation,
    // document open, and a workspace-sidebar tab click — through onSelectTab,
    // instead of only asserting resolveTargetVault/routingTrustsCurrentVault
    // in isolation. Proves fileHostFor actually resolves to remoteFileHost
    // for a live vault reached by clicking through the real UI, not a vault
    // object constructed and passed in by the test.
    it("drives onSelectTab with a real, persisted RemoteVault and reads through remote_read_file", async () => {
      localStorage.setItem("mermark.workspaceState", JSON.stringify({
        workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-remote-x"], currentVaultId: "vault-remote-x", lastSelectedPermanentVaultId: null }],
        vaults: [{ vaultId: "vault-remote-x", workspaceId: "workspace-default", displayName: "맥미니 노트", persistenceKind: "remote", rootPath: null, explorerRoot: REMOTE_VAULT_WIRE_ROOT, host: "wis-macmini", remoteVaultId: "rv-1" }],
        currentWorkspaceId: "workspace-default",
      }));
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");

      // Open the Explorer and the workspace sidebar — the remote vault is
      // already `currentVaultId` from the seeded state above, so the
      // Explorer should already be sitting at its wire root (C1: the empty
      // string, NOT "/" — the host's `safe_path` only recognizes "" as the
      // vault root) once `explorerRootForVault`/`jumpExplorerToVaultRoot` ran
      // at boot restore.
      document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="노트.md"]')).not.toBeNull());
      expect(invokeMock).toHaveBeenCalledWith("remote_list_dir", expect.objectContaining({ host: "wis-macmini", vault: "rv-1", path: REMOTE_VAULT_WIRE_ROOT }));

      document.querySelector<HTMLElement>('.explorer-file[data-path="노트.md"]')?.click();
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("remote_read_file", expect.objectContaining({ host: "wis-macmini", vault: "rv-1", path: "노트.md" })));
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("원격 문서"));
      invokeMock.mockClear();

      // Re-select the SAME (already active) tab through the workspace
      // sidebar — exactly the onSelectTab click path (workspace-sidebar.ts's
      // `activate`), not a re-open through the Explorer. A second
      // remote_read_file call here is proof onSelectTab itself — not just
      // the Explorer's own open handler — resolves the remote backend.
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('[data-vault-id="vault-remote-x"] .workspace-vault-tab')).not.toBeNull());
      const tab = document.querySelector<HTMLButtonElement>('[data-vault-id="vault-remote-x"] .workspace-vault-tab');
      tab?.click();
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("remote_read_file", expect.objectContaining({ host: "wis-macmini", vault: "rv-1", path: "노트.md" })));

      // No WorkspaceStateError surfaced — before Task 10, selectVault threw
      // for any non-"permanent" vault (workspace-state.ts), which this
      // exact click path would have hit via onSelectTab's
      // `workspaceStore.selectVault(selectedVault.vaultId)`.
      expect(document.querySelector(".workspace-error")?.hasAttribute("hidden")).toBe(true);
    });

    // C1's second symptom (final-review-ts.md): a root-level remote document
    // has no directory part (`dirOf("노트.md") === ""`), so main.ts's
    // `currentBaseDir = dirOf(file) || SAFE_EXPLORER_BASE_PATH` fallback used
    // to substitute "/" — the LOCAL filesystem root, never a valid remote
    // path. Every image in a root-level remote note broke as a result
    // (`resolveImageSrc("pic.png", "/")` → "/pic.png" → `remote_read_image`
    // 404s at the host's `RootDir` rejection). This test opens a root-level
    // remote document whose content references an image and asserts the
    // resulting `remote_read_image` call carries the bare vault-relative
    // name, not a leading-slash path.
    it("resolves a root-level remote document's image against the wire root, not the local filesystem root", async () => {
      documentContents.set("노트.md", "# 원격\n\n![그림](pic.png)\n");
      localStorage.setItem("mermark.workspaceState", JSON.stringify({
        workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-remote-img"], currentVaultId: "vault-remote-img", lastSelectedPermanentVaultId: null }],
        vaults: [{ vaultId: "vault-remote-img", workspaceId: "workspace-default", displayName: "맥미니 노트", persistenceKind: "remote", rootPath: null, explorerRoot: REMOTE_VAULT_WIRE_ROOT, host: "wis-macmini", remoteVaultId: "rv-1" }],
        currentWorkspaceId: "workspace-default",
      }));
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");

      document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="노트.md"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.explorer-file[data-path="노트.md"]')?.click();
      await vi.waitFor(() => expect(remoteReadImageCalls.length).toBeGreaterThan(0));

      expect(remoteReadImageCalls).toContain("pic.png");
      expect(remoteReadImageCalls.some((p) => p.startsWith("/"))).toBe(false);
    });

    // I3 (final-review-ts.md): ⌘-click / ⌘+Enter on a remote Explorer row
    // used to call open_path(<vault-relative name>) — a LOCAL command — which
    // either silently console.error'd (nothing visible to the user, spec §6)
    // or, if the CWD happened to hold a same-named file, opened THAT local
    // file in a new window under the remote note's name. Must refuse
    // visibly instead.
    it("⌘-click on a remote Explorer row refuses visibly instead of calling open_path against the local filesystem", async () => {
      localStorage.setItem("mermark.workspaceState", JSON.stringify({
        workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-remote-nw"], currentVaultId: "vault-remote-nw", lastSelectedPermanentVaultId: null }],
        vaults: [{ vaultId: "vault-remote-nw", workspaceId: "workspace-default", displayName: "맥미니 노트", persistenceKind: "remote", rootPath: null, explorerRoot: REMOTE_VAULT_WIRE_ROOT, host: "wis-macmini", remoteVaultId: "rv-1" }],
        currentWorkspaceId: "workspace-default",
      }));
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");

      document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="노트.md"]')).not.toBeNull());
      const row = document.querySelector<HTMLElement>('.explorer-file[data-path="노트.md"]');
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));

      await vi.waitFor(() => expect(document.querySelector(".save-status")?.textContent).toContain("원격 볼트에서는 지원하지 않습니다"));
      expect(invokeMock).not.toHaveBeenCalledWith("open_path", expect.anything());
    });

    // I4 (final review): the recovery modal's "다시 시도" used to call
    // openDocument(path) with NO targetVault, so a stale/still-open recovery
    // modal's retry re-resolved the vault via currentVault() — whatever is
    // CURRENTLY selected in the sidebar — instead of the vault the failed
    // read was actually FOR. This is the sixth instance of the same
    // currentVault()-inference bug Rulings 9/32/33 already closed at five
    // other call sites. Repro: fail a LOCAL open (captures targetVault=P),
    // then switch the sidebar to an already-open REMOTE tab WITHOUT the
    // recovery modal closing (openInWindow's success path never calls
    // closeRecovery — only the "no document open" welcome branch does), then
    // retry — it must still read through P, not the now-current remote vault.
    it("recovery modal retry uses the vault the FAILED read was for, not whatever is selected in the sidebar by the time 다시 시도 is clicked", async () => {
      documentContents.set("노트.md", "# 원격 문서");
      localStorage.setItem("mermark.workspaceState", JSON.stringify({
        workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FP", "vault-remote-i4"], currentVaultId: "vault-remote-i4", lastSelectedPermanentVaultId: null }],
        vaults: [
          { vaultId: "vault-%2FP", workspaceId: "workspace-default", displayName: "P", rootPath: "/P", persistenceKind: "permanent", explorerRoot: "/P" },
          { vaultId: "vault-remote-i4", workspaceId: "workspace-default", displayName: "맥미니 노트", persistenceKind: "remote", rootPath: null, explorerRoot: REMOTE_VAULT_WIRE_ROOT, host: "wis-macmini", remoteVaultId: "rv-1" },
        ],
        currentWorkspaceId: "workspace-default",
      }));
      vi.stubGlobal("location", { search: "", href: "" });
      rejectedReads.add("/P/fail.md");

      await import("../src/main");

      // Open the remote vault's document first, so it has a real open tab to
      // switch back to later (a remote vault's tabs are session-only — there
      // is nothing to restore from storage, it must be opened live).
      document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="노트.md"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.explorer-file[data-path="노트.md"]')?.click();
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("원격 문서"));

      // Fail a LOCAL open via the CLI-routing path (routeCliFile selects "P"
      // as a side effect, so targetVault=P is what showOpenRecovery captures).
      await vi.waitFor(() => expect(cliRoutingOrder).toContain("ready"));
      emitEvent("cli-open-request", { id: 1, path: "/P/fail.md" });
      await vi.waitFor(() => expect(document.querySelector(".recovery-backdrop")).not.toBeNull());
      invokeMock.mockClear();

      // Switch back to the remote vault's already-open tab WITHOUT the
      // recovery modal closing.
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('[data-vault-id="vault-remote-i4"] .workspace-vault-tab')).not.toBeNull());
      document.querySelector<HTMLButtonElement>('[data-vault-id="vault-remote-i4"] .workspace-vault-tab')?.click();
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("remote_read_file", expect.objectContaining({ path: "노트.md" })));
      expect(document.querySelector(".recovery-backdrop")).not.toBeNull(); // still open — never closed by the switch
      invokeMock.mockClear();

      document.querySelector<HTMLButtonElement>(".recovery-action-retry")?.click();
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("read_file", expect.objectContaining({ path: "/P/fail.md" })));
      expect(invokeMock).not.toHaveBeenCalledWith("remote_read_file", expect.anything());
      expect(invokeMock).not.toHaveBeenCalledWith("remote_list_dir", expect.anything());
    });

    // Minor (final review, same class as I3): ⌘⇧C (bundle.copy) called
    // bundle_doc(<vault-relative name>) — a LOCAL command — for a remote
    // document. Must refuse visibly via the same status-flash mechanism
    // path.copy/bundle.copy already use for failure, not silently invoke a
    // local command with a path that can't mean anything on this machine.
    it("⌘⇧C (bundle.copy) on an open remote document refuses visibly instead of calling bundle_doc against the local filesystem", async () => {
      documentContents.set("노트.md", "# 원격 문서");
      localStorage.setItem("mermark.workspaceState", JSON.stringify({
        workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-remote-bundle"], currentVaultId: "vault-remote-bundle", lastSelectedPermanentVaultId: null }],
        vaults: [{ vaultId: "vault-remote-bundle", workspaceId: "workspace-default", displayName: "맥미니 노트", persistenceKind: "remote", rootPath: null, explorerRoot: REMOTE_VAULT_WIRE_ROOT, host: "wis-macmini", remoteVaultId: "rv-1" }],
        currentWorkspaceId: "workspace-default",
      }));
      vi.stubGlobal("location", { search: "", href: "" });

      // dispatchChord must come from the SAME module instance main.ts's
      // handler registered into — this suite's afterEach calls
      // vi.resetModules(), so a static top-of-file import would resolve to
      // a stale registry from a PRIOR test's module graph.
      const { dispatchChord } = await import("../src/shortcuts/registry");
      await import("../src/main");

      document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="노트.md"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.explorer-file[data-path="노트.md"]')?.click();
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("원격 문서"));
      invokeMock.mockClear();

      dispatchChord("Mod+Shift+C");
      await vi.waitFor(() => expect(document.querySelector(".status-pos")?.textContent).toContain("원격 볼트에서는 지원하지 않습니다"));
      expect(invokeMock).not.toHaveBeenCalledWith("bundle_doc", expect.anything());
    });

    // Minor (final review): `mermark.session.${currentFile}` keyed scroll/
    // cursor state by the bare (possibly vault-relative) path alone — two
    // remote vaults sharing a same-named document ("노트.md" at each of
    // their roots) collide on the SAME localStorage key.
    it("scopes session (scroll/cursor) state by vault, not just the bare document path — two remote vaults with same-named documents don't collide", async () => {
      documentContents.set("노트.md", "# 원격 문서\n\nline2\nline3\nline4\nline5");
      localStorage.setItem("mermark.workspaceState", JSON.stringify({
        workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-remote-sess"], currentVaultId: "vault-remote-sess", lastSelectedPermanentVaultId: null }],
        vaults: [{ vaultId: "vault-remote-sess", workspaceId: "workspace-default", displayName: "맥미니 노트", persistenceKind: "remote", rootPath: null, explorerRoot: REMOTE_VAULT_WIRE_ROOT, host: "wis-macmini", remoteVaultId: "rv-sess" }],
        currentWorkspaceId: "workspace-default",
      }));
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");

      document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="노트.md"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.explorer-file[data-path="노트.md"]')?.click();
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("원격 문서"));

      const mermark = (window as any).__mermark;
      mermark.view.dispatch({ selection: { anchor: 5 } });
      await new Promise((resolve) => setTimeout(resolve, 200));

      // The OLD unscoped key must never be written (a second remote vault's
      // same-named "노트.md" would otherwise read it back as its own state).
      expect(localStorage.getItem("mermark.session.노트.md")).toBeNull();
      // The actual key must be scoped by this vault's id.
      const scopedKey = Object.keys(localStorage).find((k) => k.startsWith("mermark.session.") && k.includes("vault-remote-sess"));
      expect(scopedKey).toBeDefined();
      expect(JSON.parse(localStorage.getItem(scopedKey!) ?? "{}").cursor).toBe(5);
    });

    // Task 11: the persistent read-only indicator and the explicit
    // unsupported-file refusal, driven through the real boot + Explorer
    // click path (not the pure remote-capability.ts functions in isolation —
    // those are covered in src/document/remote-capability.test.ts).
    it("shows a persistent '읽기 전용 (원격)' mode indicator for an open remote document, and refuses an unsupported remote file type with an explicit message instead of opening a broken viewer", async () => {
      localStorage.setItem("mermark.workspaceState", JSON.stringify({
        workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-remote-y"], currentVaultId: "vault-remote-y", lastSelectedPermanentVaultId: null }],
        vaults: [{ vaultId: "vault-remote-y", workspaceId: "workspace-default", displayName: "맥미니 노트", persistenceKind: "remote", rootPath: null, explorerRoot: REMOTE_VAULT_WIRE_ROOT, host: "wis-macmini", remoteVaultId: "rv-1" }],
        currentWorkspaceId: "workspace-default",
      }));
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");

      document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="노트.md"]')).not.toBeNull());

      // Opening the remote markdown document mounts it read-only, and the
      // title-bar mode toggle reports the persistent, fixed state — not a
      // transient toast, and not the edit/read label modeSetting would
      // otherwise drive.
      document.querySelector<HTMLElement>('.explorer-file[data-path="노트.md"]')?.click();
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("원격 문서"));
      const modeToggle = document.querySelector<HTMLButtonElement>(".mode-toggle");
      expect(modeToggle?.dataset.remote).toBe("true");
      expect(modeToggle?.textContent).toContain("읽기 전용 (원격)");

      // Clicking the EPUB row must not open a (broken/empty) viewer overlay —
      // it must report the explicit "아직 지원하지 않습니다" refusal instead.
      const epubRow = document.querySelector<HTMLElement>('.explorer-file[data-path="책.epub"]');
      expect(epubRow).not.toBeNull();
      epubRow?.click();
      await vi.waitFor(() => expect(document.querySelector(".save-status")?.textContent).toContain("원격 볼트에서는 아직 지원하지 않습니다"));
      expect(document.querySelector(".viewer-panel")).toBeNull();
    });

    // Task 11 fix round 1 (Important finding): `openWithViewer` used to
    // consult `currentVault()` directly. A CLI launch or the open-path
    // prompt hands in a raw LOCAL absolute path that has nothing to do with
    // whichever vault the SIDEBAR happens to have selected — so with a
    // remote vault selected, a perfectly valid LOCAL EPUB was wrongly
    // refused with the remote "아직 지원하지 않습니다" message. The fix threads
    // an explicit target vault into `openWithViewer` instead, resolved via
    // `routeCliFile` (path-based: does this path live under a registered
    // permanent vault's root?) for these two raw-local-path entry points.
    // Both regression cases below seed a permanent vault AND a remote vault,
    // with the REMOTE vault as `currentVaultId` — the exact repro.
    const permanentPlusRemoteState = JSON.stringify({
      workspaces: [{ workspaceId: "workspace-default", vaultIds: ["vault-%2FA", "vault-remote-z"], currentVaultId: "vault-remote-z", lastSelectedPermanentVaultId: "vault-%2FA" }],
      vaults: [
        { vaultId: "vault-%2FA", workspaceId: "workspace-default", displayName: "A", rootPath: "/A", persistenceKind: "permanent", explorerRoot: "/A" },
        { vaultId: "vault-remote-z", workspaceId: "workspace-default", displayName: "맥미니 노트", persistenceKind: "remote", rootPath: null, explorerRoot: REMOTE_VAULT_WIRE_ROOT, host: "wis-macmini", remoteVaultId: "rv-1" },
      ],
      currentWorkspaceId: "workspace-default",
    });

    it("a CLI-routed LOCAL viewer file (EPUB) opens normally, not refused, even while a remote vault is selected", async () => {
      localStorage.setItem("mermark.workspaceState", permanentPlusRemoteState);
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");
      await vi.waitFor(() => expect(cliRoutingOrder).toContain("ready"));
      invokeMock.mockClear();

      emitEvent("cli-open-request", { id: 21, path: "/A/책.epub" });

      await vi.waitFor(() => expect(document.querySelector(".viewer-panel")).not.toBeNull());
      await vi.waitFor(() => expect(cliAcks).toEqual([{ id: 21, outcome: "opened" }]));
      expect(document.querySelector(".save-status")?.textContent ?? "").not.toContain("원격 볼트에서는 아직 지원하지 않습니다");
    });

    it("the open-path prompt opens a LOCAL viewer file (EPUB) normally, not refused, even while a remote vault is selected", async () => {
      localStorage.setItem("mermark.workspaceState", permanentPlusRemoteState);
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");

      const openPathBtn = document.querySelector<HTMLButtonElement>(".open-path");
      openPathBtn?.click();
      const input = document.querySelector<HTMLInputElement>(".open-path-input");
      expect(input).not.toBeNull();
      input!.value = "/A/책.epub";
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

      await vi.waitFor(() => expect(document.querySelector(".viewer-panel")).not.toBeNull());
      expect(document.querySelector(".save-status")?.textContent ?? "").not.toContain("원격 볼트에서는 아직 지원하지 않습니다");
    });

    // Task 11 fix round 2: the SAME bug lived in `openPathEntry`'s DOCUMENT
    // branch too — `openDoc(path)` was called with no vault, so `openDocument`
    // fell back to `currentVault()` (the sidebar's selection). With a remote
    // vault selected, a raw local absolute `.md` path got read through
    // `remoteFileHost` (→ `remote_read_file` with a local path the host
    // rejects) instead of the local backend, surfacing a generic
    // open-failure recovery modal for a perfectly valid local file. Fixed by
    // having `openPathEntry` resolve ONE `targetVault` (via `routeCliFile`)
    // and threading it through BOTH branches — these two tests assert the
    // document branch specifically: the file actually opens (content is
    // readable / the CLI ack is "opened"), through the LOCAL backend
    // (`read_file`, never `remote_read_file`), with no recovery modal.
    it("a CLI-routed LOCAL markdown document opens normally through the local backend, even while a remote vault is selected", async () => {
      documentContents.set("/A/note.md", "# 로컬 문서");
      localStorage.setItem("mermark.workspaceState", permanentPlusRemoteState);
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");
      await vi.waitFor(() => expect(cliRoutingOrder).toContain("ready"));
      invokeMock.mockClear();

      emitEvent("cli-open-request", { id: 22, path: "/A/note.md" });

      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("로컬 문서"));
      await vi.waitFor(() => expect(cliAcks).toEqual([{ id: 22, outcome: "opened" }]));
      expect(invokeMock.mock.calls.some(([command]) => command === "remote_read_file")).toBe(false);
      expect(invokeMock.mock.calls.some(([command, args]) => command === "read_file" && pathArg(args) === "/A/note.md")).toBe(true);
      expect(document.querySelector(".recovery-backdrop")).toBeNull();
    });

    it("the open-path prompt opens a LOCAL markdown document normally through the local backend, even while a remote vault is selected", async () => {
      documentContents.set("/A/note.md", "# 로컬 문서");
      localStorage.setItem("mermark.workspaceState", permanentPlusRemoteState);
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");
      invokeMock.mockClear();

      const openPathBtn = document.querySelector<HTMLButtonElement>(".open-path");
      openPathBtn?.click();
      const input = document.querySelector<HTMLInputElement>(".open-path-input");
      expect(input).not.toBeNull();
      input!.value = "/A/note.md";
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("로컬 문서"));
      expect(invokeMock.mock.calls.some(([command]) => command === "remote_read_file")).toBe(false);
      expect(invokeMock.mock.calls.some(([command, args]) => command === "read_file" && pathArg(args) === "/A/note.md")).toBe(true);
      expect(document.querySelector(".recovery-backdrop")).toBeNull();
    });

    // Task 11 fix round 3: recentDocsSetting used to be a bare string[] with
    // no vault identity, so opening a recent entry always read through
    // whichever vault happened to be SELECTED at click time, not the vault
    // that actually owns the entry. Reproduces both directions in one boot:
    // open a REMOTE doc (records a recent entry tagged with the remote
    // vault), then open a LOCAL doc via the CLI route (switches the
    // selected vault to the permanent one, per fix round 2) — now click the
    // REMOTE entry back (selected vault is LOCAL) and assert it reads
    // through `remote_read_file`, then click the LOCAL entry (selected
    // vault is now REMOTE again, since opening the remote entry re-selects
    // it) and assert it reads through `read_file`, never `remote_read_file`.
    it("a recent entry opens through the vault that OWNS it, not whichever vault is currently selected — both directions", async () => {
      documentContents.set("/A/note.md", "# 로컬 문서");
      localStorage.setItem("mermark.workspaceState", permanentPlusRemoteState);
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");

      // 1) Open the remote doc via the Explorer (currentVaultId is already
      //    the remote vault, per permanentPlusRemoteState) — records a
      //    recent entry tagged vault-remote-z.
      document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="노트.md"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.explorer-file[data-path="노트.md"]')?.click();
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("원격 문서"));

      // 2) Open the local doc via CLI — routeCliFile resolves + selects the
      //    permanent vault "/A" (fix round 2), so the selected vault is now
      //    LOCAL. Records a second recent entry tagged vault-%2FA.
      emitEvent("cli-open-request", { id: 31, path: "/A/note.md" });
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("로컬 문서"));

      // 3) Click the REMOTE recent entry while the LOCAL vault is selected —
      //    must read through remote_read_file, not the local backend.
      invokeMock.mockClear();
      document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
      const remoteRecentItem = document.querySelector<HTMLElement>('.recent-item[data-path="노트.md"]');
      expect(remoteRecentItem).not.toBeNull();
      expect(remoteRecentItem?.dataset.vaultId).toBe("vault-remote-z");
      remoteRecentItem?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("remote_read_file", expect.objectContaining({ host: "wis-macmini", vault: "rv-1", path: "노트.md" })));
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("원격 문서"));

      // 4) Click the LOCAL recent entry while the REMOTE vault is now
      //    selected (step 3 re-selected it) — must read through read_file,
      //    never remote_read_file.
      invokeMock.mockClear();
      document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
      const localRecentItem = document.querySelector<HTMLElement>('.recent-item[data-path="/A/note.md"]');
      expect(localRecentItem).not.toBeNull();
      expect(localRecentItem?.dataset.vaultId).toBe("vault-%2FA");
      localRecentItem?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("로컬 문서"));
      expect(invokeMock.mock.calls.some(([command]) => command === "remote_read_file")).toBe(false);
      expect(invokeMock.mock.calls.some(([command, args]) => command === "read_file" && pathArg(args) === "/A/note.md")).toBe(true);
    });

    // Migration: an old plain string[] recentDocs value (pre-Task-11) must
    // load without loss — each legacy path attaches to the local vault that
    // owns it and stays clickable through the recent panel exactly as
    // before.
    it("migrates a legacy string[] recentDocs value and opens it correctly through the recent panel", async () => {
      documentContents.set("/A/legacy.md", "# 레거시 문서");
      localStorage.setItem("mermark.recentDocs", JSON.stringify(["/A/legacy.md"]));
      vi.stubGlobal("location", { search: "?file=/A/start.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("document"));
      invokeMock.mockClear();

      document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
      const item = document.querySelector<HTMLElement>('.recent-item[data-path="/A/legacy.md"]');
      expect(item).not.toBeNull();
      // Migrated to the permanent vault "/A" auto-registered by the ?file=
      // cold launch above (routeCliFileResolved), not left un-migrated or
      // dropped. `toBeTruthy` (not `not.toBe("")`) matters: pre-migration
      // code never sets `dataset.vaultId` at all, so it reads back as
      // `undefined` — a weaker `not.toBe("")` assertion would pass against
      // BOTH the fixed and the unfixed code and prove nothing.
      expect(item?.dataset.vaultId).toBeTruthy();
      item?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("레거시 문서"));
      expect(invokeMock.mock.calls.some(([command]) => command === "remote_read_file")).toBe(false);
    });

    // A recent entry whose vault no longer exists (a remote vault unpaired,
    // or any vault removed, since the entry was recorded) must fail
    // gracefully — a clear status-bar message, never a thrown error and
    // never a silent fall-through to whatever vault happens to be selected
    // (that fallback is exactly the bug this whole round fixes).
    it("a recent entry whose vault no longer exists fails gracefully via the status bar, not a throw or a wrong-vault open", async () => {
      documentContents.set("/A/start.md", "# start");
      localStorage.setItem("mermark.recentDocs", JSON.stringify([{ path: "유령.md", vaultId: "vault-ghost-removed" }]));
      vi.stubGlobal("location", { search: "?file=/A/start.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("start"));
      invokeMock.mockClear();

      document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
      const item = document.querySelector<HTMLElement>('.recent-item[data-path="유령.md"]');
      expect(item).not.toBeNull();
      expect(item?.dataset.vaultId).toBe("vault-ghost-removed");
      item?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

      await vi.waitFor(() => expect(document.querySelector(".save-status")?.textContent).toContain("볼트를 찾을 수 없습니다"));
      // Never reached any backend for the ghost entry, and the still-open
      // local document stayed exactly as it was — no wrong-vault read, no
      // crash, no recovery modal.
      expect(invokeMock.mock.calls.some(([command]) => command === "remote_read_file")).toBe(false);
      expect(invokeMock.mock.calls.some(([, args]) => pathArg(args) === "유령.md")).toBe(false);
      expect(document.querySelector(".cm-content")?.textContent).toBe("start");
      expect(document.querySelector(".recovery-backdrop")).toBeNull();
    });
  });
});
