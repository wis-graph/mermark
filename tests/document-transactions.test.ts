// Characterization tests for the FOUR open transactions (T1 openDocument/
// openDocumentSafely, T2 onSelectVault welcome branch, T3 onCloseTab active
// branch, T4 navigateHistory) and the THREE reload-vs-in-place call sites
// (R1 explorer, R2 recent, R3 search) main.ts currently hand-rolls — written
// BEFORE the DocumentSession extraction (_workspace/01_architect_design.md
// §5.2) so every scenario below is a lock on HEAD's actual observed
// behavior, not a re-derivation of the design doc's prose. IDs match the
// design's table (C1.x/C2.x/C3.x/C4.x/CR.x) so a reviewer can cross-reference.
//
// Four tests are marked CHARACTERIZATION(BC-n): they pin CURRENT (arguably
// accidental) behavior that the design proposes changing under owner
// approval (BC-1/BC-2/BC-3). Their expectations flip in the BC-n commit —
// see that commit's own comment.
//
// This file uses its OWN small invoke mock (deliberately smaller than
// tests/main-wiring.test.ts's) — same boot shape, same jsdom harness.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { REMOTE_VAULT_WIRE_ROOT } from "../src/workspace/workspace-state";

// dispatchChord is re-imported FRESH inside each T4 test, AFTER `await
// import("../src/main")` — main.ts's own dynamic import (post
// vi.resetModules() in afterEach) gets a NEW instance of shortcuts/registry
// every test; a static top-level import here would keep pointing at the
// FIRST instance forever and silently no-op (registerHandler/installDispatcher
// ran against a different module graph than this binding reads).
async function goBackChord(): Promise<void> {
  const { dispatchChord } = await import("../src/shortcuts/registry");
  dispatchChord("Mod+[");
}
async function goForwardChord(): Promise<void> {
  const { dispatchChord } = await import("../src/shortcuts/registry");
  dispatchChord("Mod+]");
}

// ── invoke mock ──────────────────────────────────────────────────────────
const pathArg = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null || !("path" in args) || typeof args.path !== "string") return undefined;
  return args.path;
};

const documentContents = new Map<string, string>();
const watcherEvents: string[] = [];
const deferredReads = new Map<string, { promise: Promise<unknown> }>();
const rejectingReads = new Map<string, { resolve(): void; promise: Promise<unknown> }>();
const rejectedReads = new Set<string>();
const rejectedRemotePaths = new Set<string>();
const deferredWatches = new Map<string, { promise: Promise<void> }>();
let rejectWatchPath: string | undefined;
let rejectUnwatch = false;
let rejectWrites = false;
let deferredWrite: { promise: Promise<number> } | undefined;
let watcherGeneration = 0;
const eventListeners = new Map<string, Set<(event: { readonly payload: unknown }) => void>>();
const cliAcks: { id: number; outcome: string }[] = [];
let scanResult: unknown = { files: [], truncated: false };
const dirListing = new Map<string, { name: string; path: string; is_dir: boolean }[]>();

const invokeMock = vi.fn((command: string, args?: unknown): Promise<unknown> => {
  const path = pathArg(args) ?? "";
  if (command === "canonicalize_path") return Promise.resolve(path);
  if (command === "read_file") {
    if (rejectedReads.has(path)) return Promise.reject(new Error("read failed"));
    const deferredReject = rejectingReads.get(path);
    if (deferredReject) return deferredReject.promise;
    const deferred = deferredReads.get(path);
    if (deferred) return deferred.promise;
    return Promise.resolve({ text: documentContents.get(path) ?? "# document", mtime: 1 });
  }
  if (command === "write_file") {
    if (rejectWrites) return Promise.reject(new Error("write failed"));
    if (deferredWrite) return deferredWrite.promise;
    return Promise.resolve(2);
  }
  if (command === "list_dir") return Promise.resolve(dirListing.get(path) ?? []);
  if (command === "list_files_recursive") return Promise.resolve(scanResult);
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
    return Promise.resolve();
  }
  if (command === "register_window_ready") return Promise.resolve(undefined);
  if (command === "acknowledge_open_request") {
    const a = args as Record<string, unknown>;
    cliAcks.push({ id: Number(a.id ?? -1), outcome: String(a.outcome ?? "") });
    return Promise.resolve(undefined);
  }
  if (command === "remote_list_dir") {
    const a = args as Record<string, unknown>;
    const remotePath = String(a.path ?? "");
    if (remotePath.startsWith("/")) return Promise.reject(new Error("REMOTE:SharingOff"));
    if (remotePath === REMOTE_VAULT_WIRE_ROOT) {
      return Promise.resolve([{ name: "노트.md", path: "노트.md", is_dir: false }]);
    }
    return Promise.resolve([]);
  }
  if (command === "remote_read_file") {
    const a = args as Record<string, unknown>;
    const remotePath = String(a.path ?? "");
    if (rejectedRemotePaths.has(remotePath)) return Promise.reject(new Error("REMOTE:SharingOff"));
    return Promise.resolve({ text: documentContents.get(remotePath) ?? "# 원격 문서", mtime: 1 });
  }
  return Promise.resolve(false);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

const listenMock = vi.fn(
  (event: string, listener: (event: { readonly payload: unknown }) => void, _options?: unknown) => {
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
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", onCloseRequested: () => Promise.resolve(() => {}) }),
}));

const mainSource = readFileSync("src/main.ts", "utf8");

// ── fixtures ─────────────────────────────────────────────────────────────
const permanentVaultId = (root: string) => `vault-${encodeURIComponent(root)}`;

function seedWorkspace(opts: {
  vaults: { root: string; displayName?: string }[];
  currentVaultId?: string;
  tabsByRoot?: Record<string, { tabId: string; path: string }[]>;
  activeTabByRoot?: Record<string, string>;
}): void {
  const vaults = opts.vaults.map((v) => ({
    vaultId: permanentVaultId(v.root),
    workspaceId: "workspace-default",
    displayName: v.displayName ?? v.root,
    rootPath: v.root,
    persistenceKind: "permanent" as const,
    explorerRoot: v.root,
  }));
  localStorage.setItem("mermark.workspaceState", JSON.stringify({
    workspaces: [{
      workspaceId: "workspace-default",
      vaultIds: vaults.map((v) => v.vaultId),
      currentVaultId: opts.currentVaultId ?? vaults[0]?.vaultId ?? "vault-global",
      lastSelectedPermanentVaultId: vaults[0]?.vaultId ?? null,
    }],
    vaults,
    currentWorkspaceId: "workspace-default",
  }));
  for (const [root, tabs] of Object.entries(opts.tabsByRoot ?? {})) {
    const vaultId = permanentVaultId(root);
    localStorage.setItem(`mermark.vaultTabs.${vaultId}`, JSON.stringify({
      vaultId,
      tabs,
      activeTabId: opts.activeTabByRoot?.[root] ?? tabs[tabs.length - 1]?.tabId ?? null,
    }));
  }
}

function seedRemoteWorkspace(opts: { currentVaultId?: string; host?: string; remoteVaultId?: string }): { vaultId: string } {
  const vaultId = "vault-remote-1";
  const remote = {
    vaultId,
    workspaceId: "workspace-default",
    displayName: "원격 볼트",
    rootPath: null,
    persistenceKind: "remote" as const,
    explorerRoot: REMOTE_VAULT_WIRE_ROOT,
    host: opts.host ?? "wis-macmini",
    remoteVaultId: opts.remoteVaultId ?? "rv-1",
  };
  localStorage.setItem("mermark.workspaceState", JSON.stringify({
    workspaces: [{ workspaceId: "workspace-default", vaultIds: [vaultId], currentVaultId: opts.currentVaultId ?? vaultId, lastSelectedPermanentVaultId: null }],
    vaults: [remote],
    currentWorkspaceId: "workspace-default",
  }));
  return { vaultId };
}

const liveEditor = (): { readonly view: EditorView } | undefined =>
  (window as Window & { readonly __mermark?: { readonly view: EditorView } }).__mermark;

const closeTabButton = (tabId: string): HTMLButtonElement | null =>
  (document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)?.nextElementSibling as HTMLButtonElement) ?? null;

const cmText = (): string | undefined => document.querySelector(".cm-content")?.textContent ?? undefined;

describe("document transactions (characterization — pre-DocumentSession)", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { search: "" });
    localStorage.clear();
    invokeMock.mockClear();
    documentContents.clear();
    watcherEvents.length = 0;
    deferredReads.clear();
    rejectingReads.clear();
    rejectedReads.clear();
    rejectedRemotePaths.clear();
    deferredWatches.clear();
    rejectWatchPath = undefined;
    rejectUnwatch = false;
    rejectWrites = false;
    deferredWrite = undefined;
    watcherGeneration = 0;
    eventListeners.clear();
    cliAcks.length = 0;
    scanResult = { files: [], truncated: false };
    dirListing.clear();
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

  // ── T1: openDocument/openDocumentSafely (onSelectTab is the exercised entry) ──
  describe("T1 — openDocument via onSelectTab", () => {
    it("C1.1: selecting tab b opens it, watcher hands off, recent leads with it", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      seedWorkspace({
        vaults: [{ root: "/P" }],
        tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] },
        activeTabByRoot: { "/P": "a" },
      });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      watcherEvents.length = 0;
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("B"));

      expect(watcherEvents).toEqual(["unwatch", "watch /P/b.md"]);
      expect(document.querySelector('[data-tab-id="b"]')?.getAttribute("data-active")).toBe("true");
      expect(JSON.parse(localStorage.getItem("mermark.recentDocs") ?? "[]")[0]).toMatchObject({ path: "/P/b.md" });
    });

    it("C1.2: B read stalls, C completes first, then B resolves stale and is dropped silently", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/c.md", "# C");
      let resolveB: ((value: unknown) => void) | undefined;
      deferredReads.set("/P/b.md", { promise: new Promise((resolve) => { resolveB = resolve; }) });
      seedWorkspace({
        vaults: [{ root: "/P" }],
        tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }, { tabId: "c", path: "/P/c.md" }] },
        activeTabByRoot: { "/P": "a" },
      });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="c"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("C"));
      watcherEvents.length = 0;
      resolveB?.({ text: "# B", mtime: 1 });
      await new Promise((r) => setTimeout(r, 20));

      expect(cmText()).toBe("C");
      expect(document.querySelector(".recovery-modal")).toBeNull();
      expect(watcherEvents).not.toContain("watch /P/b.md");
    });

    it("C1.3: B read rejects while stale (after C already opened) — swallowed, no recovery modal", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/c.md", "# C");
      let rejectB: (() => void) | undefined;
      rejectingReads.set("/P/b.md", { resolve() {}, promise: new Promise((_resolve, reject) => { rejectB = () => reject(new Error("b failed")); }) });
      seedWorkspace({
        vaults: [{ root: "/P" }],
        tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }, { tabId: "c", path: "/P/c.md" }] },
        activeTabByRoot: { "/P": "a" },
      });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="c"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("C"));
      rejectB?.();
      await new Promise((r) => setTimeout(r, 20));

      expect(cmText()).toBe("C");
      expect(document.querySelector(".recovery-modal")).toBeNull();
    });

    it("C1.4: the CURRENT request's read failure shows an open-read recovery modal, editor unchanged", async () => {
      documentContents.set("/P/a.md", "# A");
      rejectedReads.add("/P/b.md");
      seedWorkspace({
        vaults: [{ root: "/P" }],
        tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] },
        activeTabByRoot: { "/P": "a" },
      });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      await vi.waitFor(() => expect(document.querySelector(".recovery-modal")).not.toBeNull());

      expect(document.querySelector(".recovery-modal")?.getAttribute("aria-label")).toBe("파일을 열 수 없습니다");
      expect(cmText()).toBe("A");
      expect(document.querySelector('[data-tab-id="a"]')?.getAttribute("data-active")).toBe("true");
    });

    it("C1.5: dirty + save rejected on switch — save recovery, original document kept, target not mounted", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      seedWorkspace({
        vaults: [{ root: "/P" }],
        tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] },
        activeTabByRoot: { "/P": "a" },
      });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      liveEditor()?.view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
      rejectWrites = true;
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      await vi.waitFor(() => expect(document.querySelector(".recovery-modal")).not.toBeNull());

      expect(document.querySelector(".recovery-modal")?.getAttribute("aria-label")).toBe("저장하지 못했습니다");
      expect(cmText()).toContain("A");
      expect(document.querySelector('[data-tab-id="a"]')?.getAttribute("data-active")).toBe("true");
    });

    it("C1.6: dirty save succeeds but B's watch attach fails — A stays, watcher rolls back, next edit autosaves again (resumeWrites)", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      rejectWatchPath = "/P/b.md";
      seedWorkspace({
        vaults: [{ root: "/P" }],
        tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] },
        activeTabByRoot: { "/P": "a" },
      });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      watcherEvents.length = 0;
      liveEditor()?.view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      await vi.waitFor(() => expect(watcherEvents).toEqual(["unwatch", "watch /P/b.md", "watch /P/a.md"]));

      expect(cmText()).toContain("A");
      invokeMock.mockClear();
      liveEditor()?.view.dispatch({ changes: { from: 0, to: 0, insert: "y" } });
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("write_file", expect.anything()));
    });

    it("C1.7: onCommit only fires on success — active tab stays a while b's read is pending, flips to b once it resolves", async () => {
      documentContents.set("/P/a.md", "# A");
      let resolveB: ((value: unknown) => void) | undefined;
      deferredReads.set("/P/b.md", { promise: new Promise((resolve) => { resolveB = resolve; }) });
      seedWorkspace({
        vaults: [{ root: "/P" }],
        tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] },
        activeTabByRoot: { "/P": "a" },
      });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();

      expect(document.querySelector('[data-tab-id="a"]')?.getAttribute("data-active")).toBe("true");
      expect(cmText()).toBe("A");
      resolveB?.({ text: "# B", mtime: 1 });
      await vi.waitFor(() => expect(cmText()).toBe("B"));
      expect(document.querySelector('[data-tab-id="b"]')?.getAttribute("data-active")).toBe("true");
    });
  });

  // ── T2: onSelectVault's welcome (no-tab) branch ──────────────────────────
  describe("T2 — enterVaultWelcome via onSelectVault", () => {
    it("C2.1: selecting a tabless vault Q shows welcome, marks it current, unwatches only, jumps explorer to its root", async () => {
      seedWorkspace({ vaults: [{ root: "/P" }, { root: "/Q" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }] }, activeTabByRoot: { "/P": "a" } });
      documentContents.set("/P/a.md", "# A");
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      watcherEvents.length = 0;
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLElement>(`[data-vault-id="${permanentVaultId("/Q")}"] .workspace-vault-select`)?.click();
      await vi.waitFor(() => expect(document.querySelector(".editor-host")?.classList.contains("welcome-host")).toBe(true));

      expect(watcherEvents).toEqual(["unwatch"]);
      expect(document.querySelector(`[data-vault-id="${permanentVaultId("/Q")}"] .workspace-vault-select`)?.getAttribute("aria-current")).toBe("true");
      expect(document.querySelector(".breadcrumb")?.getAttribute("aria-label")).toBe("현재 폴더 경로: /Q");
    });

    it("C2.2: entering welcome for Q while its own commitBeforeSwitch save is delayed, but a DIFFERENT document open wins the race", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      seedWorkspace({
        vaults: [{ root: "/P" }, { root: "/Q" }],
        tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] },
        activeTabByRoot: { "/P": "a" },
      });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      liveEditor()?.view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
      let resolveWrite: ((v: number) => void) | undefined;
      deferredWrite = { promise: new Promise((resolve) => { resolveWrite = resolve; }) };
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLElement>(`[data-vault-id="${permanentVaultId("/Q")}"] .workspace-vault-select`)?.click();
      // Race it: select tab b (a plain, non-dirty target) while Q's commitBeforeSwitch save is still pending.
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      resolveWrite?.(2);
      await vi.waitFor(() => expect(cmText()).toBe("B"));

      expect(document.querySelector(".editor-host")?.classList.contains("welcome-host")).toBe(false);
      expect(document.querySelector(`[data-vault-id="${permanentVaultId("/Q")}"] .workspace-vault-select`)?.getAttribute("aria-current")).toBe("false");
    });

    it("C2.3: unwatch rejects on the way to welcome — original document kept, Q not selected, next edit still autosaves", async () => {
      documentContents.set("/P/a.md", "# A");
      seedWorkspace({ vaults: [{ root: "/P" }, { root: "/Q" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      liveEditor()?.view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
      rejectUnwatch = true;
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLElement>(`[data-vault-id="${permanentVaultId("/Q")}"] .workspace-vault-select`)?.click();
      await vi.waitFor(() => expect(watcherEvents).toContain("unwatch"));
      await new Promise((r) => setTimeout(r, 20));

      expect(document.querySelector(".editor-host")?.classList.contains("welcome-host")).toBe(false);
      expect(document.querySelector(`[data-vault-id="${permanentVaultId("/Q")}"] .workspace-vault-select`)?.getAttribute("aria-current")).toBe("false");
      rejectUnwatch = false;
      invokeMock.mockClear();
      liveEditor()?.view.dispatch({ changes: { from: 0, to: 0, insert: "y" } });
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("write_file", expect.anything()));
    });
  });

  // ── T3: onCloseTab's active-tab branch ───────────────────────────────────
  describe("T3 — closeActiveTab via onCloseTab", () => {
    it("C3.1: closing active tab a with [a,b] mounts b, drops a, hands off the watcher", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      watcherEvents.length = 0;
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      closeTabButton("a")?.click();
      await vi.waitFor(() => expect(cmText()).toBe("B"));

      expect(document.querySelector('[data-tab-id="a"]')).toBeNull();
      expect(watcherEvents).toEqual(["unwatch", "watch /P/b.md"]);
    });

    it("C3.2: closing the last remaining tab shows welcome with zero tabs", async () => {
      documentContents.set("/P/a.md", "# A");
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      closeTabButton("a")?.click();
      await vi.waitFor(() => expect(document.querySelector(".editor-host")?.classList.contains("welcome-host")).toBe(true));

      expect(document.querySelector('[data-tab-id]')).toBeNull();
    });

    it("C3.3: nextTab read fails — open-read recovery (nextTab's path), tab a NOT closed, editor unchanged", async () => {
      documentContents.set("/P/a.md", "# A");
      rejectedReads.add("/P/b.md");
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      closeTabButton("a")?.click();
      await vi.waitFor(() => expect(document.querySelector(".recovery-modal")).not.toBeNull());

      expect(document.querySelector(".recovery-modal")?.getAttribute("aria-label")).toBe("파일을 열 수 없습니다");
      expect(cmText()).toBe("A");
      expect(document.querySelector('[data-tab-id="a"]')).not.toBeNull();
    });

    it("C3.4: nextTab read stalls, user picks tab c meanwhile, c wins — a stays in the tab list", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/c.md", "# C");
      let resolveB: ((value: unknown) => void) | undefined;
      deferredReads.set("/P/b.md", { promise: new Promise((resolve) => { resolveB = resolve; }) });
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }, { tabId: "c", path: "/P/c.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      closeTabButton("a")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="c"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("C"));
      resolveB?.({ text: "# B", mtime: 1 });
      await new Promise((r) => setTimeout(r, 20));

      expect(cmText()).toBe("C");
      expect(document.querySelector('[data-tab-id="a"]')).not.toBeNull();
    });

    it("C3.5: BC-3 — closing inactive tab b while active tab c's own close races b's nextTab read: the commit-time guard aborts instead of mounting B's content under A's path", async () => {
      // [a,b,c] active c. Close c (lifecycle transaction begins reading
      // nextTab=b). WHILE that read is pending, close the now-inactive b
      // directly (guard fires: !wasActive → vaultTabs.close(b) with no
      // lifecycle participation at all — ordinary token staleness can't see
      // this). When c's transaction's read of b resolves, its token is
      // STILL current (nothing invalidated it), so it reaches the BC-3
      // guard: re-derive "what would be last after removing c" from the
      // CURRENT vaultTabs store (now [a, c] — b's gone) and compare to
      // nextTab (b). Mismatch → abort: resumeWrites, tab c stays open and
      // mounted, exactly as it was before any of this started.
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      documentContents.set("/P/c.md", "# C");
      let resolveB: ((value: unknown) => void) | undefined;
      deferredReads.set("/P/b.md", { promise: new Promise((resolve) => { resolveB = resolve; }) });
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }, { tabId: "c", path: "/P/c.md" }] }, activeTabByRoot: { "/P": "c" } });
      vi.stubGlobal("location", { search: "?file=/P/c.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("C"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      closeTabButton("c")?.click(); // begins reading nextTab=b (active close, lifecycle txn)
      closeTabButton("b")?.click(); // inactive close, no lifecycle — vaultTabs.close(b) immediately
      await vi.waitFor(() => expect(document.querySelector('[data-tab-id="b"]')).toBeNull());
      resolveB?.({ text: "# B", mtime: 1 });
      await new Promise((r) => setTimeout(r, 20));

      expect(document.querySelector('[data-tab-id="c"]')?.getAttribute("data-active")).toBe("true");
      expect(document.querySelector('[data-tab-id="a"]')).not.toBeNull();
      expect(cmText()).toBe("C"); // BC-3: aborted — never mounted B's content anywhere
    });
  });

  // ── T4: navigateHistory (⌘[ / ⌘]) ────────────────────────────────────────
  describe("T4 — navigateHistory via goBack/goForward", () => {
    it("C4.1: A→B(tab) then ⌘[ returns to A and re-watches it; ⌘] returns to B", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("B"));
      watcherEvents.length = 0;
      await goBackChord();
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      expect(watcherEvents).toContain("watch /P/a.md");
      await goForwardChord();
      await vi.waitFor(() => expect(cmText()).toBe("B"));
    });

    it("C4.2: ⌘[ at the start of history is a no-op", async () => {
      documentContents.set("/P/a.md", "# A");
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      await goBackChord();
      await new Promise((r) => setTimeout(r, 20));
      expect(cmText()).toBe("A");
    });

    it("C4.3: A→B, A's history read rejects on ⌘[ — B stays, no recovery modal, the dead entry is pruned", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      rejectedReads.add("/P/a.md"); // it read fine at boot; now becomes unreadable for the history hop
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("B"));
      await goBackChord();
      await new Promise((r) => setTimeout(r, 20));

      expect(cmText()).toBe("B");
      expect(document.querySelector(".recovery-modal")).toBeNull();
      rejectedReads.delete("/P/a.md");
      await goBackChord(); // pruned — this should now be a no-op (nothing older left)
      await new Promise((r) => setTimeout(r, 20));
      expect(cmText()).toBe("B");
    });

    it("C4.4: A→B, ⌘[ then ⌘] lands back on B without re-pushing (viaHistory doesn't record)", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("B"));
      await goBackChord();
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      await goForwardChord();
      await vi.waitFor(() => expect(cmText()).toBe("B"));
      await goForwardChord(); // already at the end
      await new Promise((r) => setTimeout(r, 20));
      expect(cmText()).toBe("B");
    });

    it("C4.5: dirty B + save rejects on ⌘[ — save recovery, B kept, pointer unchanged (⌘] does nothing)", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("B"));
      liveEditor()?.view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
      rejectWrites = true;
      await goBackChord();
      await vi.waitFor(() => expect(document.querySelector(".recovery-modal")).not.toBeNull());

      expect(document.querySelector(".recovery-modal")?.getAttribute("aria-label")).toBe("저장하지 못했습니다");
      expect(cmText()).toContain("B");
      document.querySelector<HTMLButtonElement>(".recovery-cancel")?.click();
      rejectWrites = false;
      await goForwardChord();
      await new Promise((r) => setTimeout(r, 20));
      expect(cmText()).toContain("B");
    });

    it("C4.6: BC-2 — dirty B saved ok but A's watch attach rejects on ⌘[: B stays, and autosave DOES resume (resumeWrites on abort)", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("B"));
      liveEditor()?.view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
      rejectWatchPath = "/P/a.md";
      await goBackChord();
      await vi.waitFor(() => expect(watcherEvents).toContain("watch /P/a.md"));
      await new Promise((r) => setTimeout(r, 20));

      expect(cmText()).toContain("B");
      rejectWatchPath = undefined;
      invokeMock.mockClear();
      liveEditor()?.view.dispatch({ changes: { from: 0, to: 0, insert: "z" } });
      // BC-2: T4 now resumeWrites() on abort, same as T1/T2/T3 — the next
      // edit autosaves normally instead of staying suspended.
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("write_file", expect.anything()));
    });

    it("C4.7: BC-1 — recent-panel read of C stalls, ⌘[ mounts A immediately, then C's now-stale read resolves and is DROPPED (last user action wins)", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      documentContents.set("/P/c.md", "# C");
      localStorage.setItem("mermark.recentDocs", JSON.stringify([{ path: "/P/c.md", vaultId: permanentVaultId("/P") }]));
      let resolveC: ((value: unknown) => void) | undefined;
      deferredReads.set("/P/c.md", { promise: new Promise((resolve) => { resolveC = resolve; }) });
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("B"));
      document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
      document.querySelector<HTMLElement>('.recent-item[data-path="/P/c.md"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); // C read pending
      await goBackChord(); // A mounts immediately (no read involved: it's already a live tab's path — still goes through T1 read though)
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      resolveC?.({ text: "# C", mtime: 1 });
      await new Promise((r) => setTimeout(r, 20));

      // BC-1: T4 now shares the SAME lifecycle counter as T1/T2/T3 — ⌘[
      // invalidated the recent-panel's in-flight token, so C's late read is
      // dropped silently (no mount, no recovery modal) instead of clobbering
      // the later user action.
      expect(cmText()).toBe("A");
      expect(document.querySelector(".recovery-modal")).toBeNull();
    });

    it("C4.8: BC-1 — ⌘[ read of A stalls, tab C opens and completes first; A's now-stale read resolves and is DROPPED (last user action still wins)", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      documentContents.set("/P/c.md", "# C");
      let resolveA: ((value: unknown) => void) | undefined;
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }, { tabId: "c", path: "/P/c.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("B"));
      deferredReads.set("/P/a.md", { promise: new Promise((resolve) => { resolveA = resolve; }) });
      await goBackChord(); // A read pending
      document.querySelector<HTMLButtonElement>('[data-tab-id="c"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("C"));
      resolveA?.({ text: "# A", mtime: 1 });
      await new Promise((r) => setTimeout(r, 20));

      // BC-1: same shared counter, opposite direction —
      // the later click (tab C) finishes first, and the EARLIER, now-stale
      // ⌘[ read resolving afterward no longer overwrites it.
      expect(cmText()).toBe("C");
      expect(document.querySelector(".recovery-modal")).toBeNull();
    });

    it("C4.10: BC-1 — a REAL history move invalidates an in-flight openDocument (the earlier request's stale read is dropped, no recovery modal)", async () => {
      documentContents.set("/P/a.md", "# A");
      documentContents.set("/P/b.md", "# B");
      documentContents.set("/P/c.md", "# C");
      seedWorkspace({ vaults: [{ root: "/P" }], tabsByRoot: { "/P": [{ tabId: "a", path: "/P/a.md" }, { tabId: "b", path: "/P/b.md" }, { tabId: "c", path: "/P/c.md" }] }, activeTabByRoot: { "/P": "a" } });
      vi.stubGlobal("location", { search: "?file=/P/a.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("A"));
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLButtonElement>('[data-tab-id="c"]')?.click(); // history: [a, c]
      await vi.waitFor(() => expect(cmText()).toBe("C"));
      let resolveB: ((value: unknown) => void) | undefined;
      deferredReads.set("/P/b.md", { promise: new Promise((resolve) => { resolveB = resolve; }) });
      document.querySelector<HTMLButtonElement>('[data-tab-id="b"]')?.click(); // B read pending (T1)
      await goBackChord(); // a REAL move (c -> a) — invalidates B's in-flight token
      await vi.waitFor(() => expect(cmText()).toBe("A"));

      resolveB?.({ text: "# B", mtime: 1 });
      await new Promise((r) => setTimeout(r, 20));

      expect(cmText()).toBe("A");
      expect(document.querySelector(".recovery-modal")).toBeNull();
    });

    it("C4.9: a remote document in history reads through its OWN vault (remote_read_file), not the currently-selected local vault", async () => {
      // Seed BOTH vaults before boot (a runtime workspaceStore.registerCanonicalVault
      // call would be needed to add a vault after boot, since main.ts's live
      // WorkspaceStore instance never re-reads localStorage — writing to it
      // mid-test is a no-op for the running app).
      const pRoot = "/P";
      const pVaultId = permanentVaultId(pRoot);
      const remoteVaultId = "vault-remote-1";
      documentContents.set("노트.md", "# 원격 문서");
      documentContents.set("/P/a.md", "# A");
      localStorage.setItem("mermark.workspaceState", JSON.stringify({
        workspaces: [{ workspaceId: "workspace-default", vaultIds: [remoteVaultId, pVaultId], currentVaultId: remoteVaultId, lastSelectedPermanentVaultId: pVaultId }],
        vaults: [
          { vaultId: remoteVaultId, workspaceId: "workspace-default", displayName: "원격 볼트", rootPath: null, persistenceKind: "remote", explorerRoot: REMOTE_VAULT_WIRE_ROOT, host: "wis-macmini", remoteVaultId: "rv-1" },
          { vaultId: pVaultId, workspaceId: "workspace-default", displayName: "P", rootPath: pRoot, persistenceKind: "permanent", explorerRoot: pRoot },
        ],
        currentWorkspaceId: "workspace-default",
      }));
      localStorage.setItem(`mermark.vaultTabs.${pVaultId}`, JSON.stringify({ vaultId: pVaultId, tabs: [{ tabId: "a", path: "/P/a.md" }], activeTabId: "a" }));
      vi.stubGlobal("location", { search: "" });

      await import("../src/main");
      document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="노트.md"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.explorer-file[data-path="노트.md"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("원격 문서"));

      // Now switch selection to the local permanent vault P (its own tab
      // already exists, so this is onSelectVault's synchronous "document"
      // branch — T1 with an explicit targetVault).
      invokeMock.mockClear();
      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      document.querySelector<HTMLElement>(`[data-vault-id="${pVaultId}"] .workspace-vault-select`)?.click();
      await vi.waitFor(() => expect(cmText()).toBe("A"));

      invokeMock.mockClear();
      await goBackChord(); // back to the remote entry
      await vi.waitFor(() => expect(cmText()).toBe("원격 문서"));
      expect(invokeMock).toHaveBeenCalledWith("remote_read_file", expect.objectContaining({ path: "노트.md" }));
    });
  });

  // ── R1/R2/R3: reload-vs-in-place (explorer/recent/search share one rule body) ──
  describe("R1/R2/R3 — reload-vs-in-place", () => {
    it("CR.1: no document open, permanent vault target via Recent — reload URL has no vault/root param", async () => {
      seedWorkspace({ vaults: [{ root: "/P" }] });
      localStorage.setItem("mermark.recentDocs", JSON.stringify([{ path: "/P/x.md", vaultId: permanentVaultId("/P") }]));
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");
      await new Promise((r) => setTimeout(r, 50));
      document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
      document.querySelector<HTMLElement>('.recent-item[data-path="/P/x.md"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

      const reload = new URL(location.href, "https://mermark.test/");
      expect(reload.searchParams.get("file")).toBe("/P/x.md");
      expect(reload.searchParams.get("vault")).toBeNull();
      expect(reload.searchParams.get("root")).toBeNull();
    });

    it("CR.1b: no document open, global vault target via Recent — reload URL carries vault=global&root=<explorer folder>", async () => {
      localStorage.setItem("mermark.recentDocs", JSON.stringify([{ path: "/G/x.md", vaultId: "vault-global" }]));
      vi.stubGlobal("location", { search: "", href: "" });

      await import("../src/main");
      await new Promise((r) => setTimeout(r, 50));
      document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
      document.querySelector<HTMLElement>('.recent-item[data-path="/G/x.md"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

      const reload = new URL(location.href, "https://mermark.test/");
      expect(reload.searchParams.get("file")).toBe("/G/x.md");
      expect(reload.searchParams.get("vault")).toBe("global");
      expect(reload.searchParams.get("root")).toBe("/");
    });

    it("CR.2: no document open, remote vault target — opens in place (remote_read_file), no reload", async () => {
      seedRemoteWorkspace({});
      documentContents.set("노트.md", "# 원격 문서");
      localStorage.setItem("mermark.recentDocs", JSON.stringify([{ path: "노트.md", vaultId: "vault-remote-1" }]));
      vi.stubGlobal("location", { search: "", href: "https://mermark.test/index.html" });

      await import("../src/main");
      await new Promise((r) => setTimeout(r, 50));
      document.querySelector<HTMLButtonElement>(".recent-btn")?.click();
      document.querySelector<HTMLElement>('.recent-item[data-path="노트.md"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await vi.waitFor(() => expect(cmText()).toBe("원격 문서"));

      expect(location.href).toBe("https://mermark.test/index.html");
      expect(invokeMock).toHaveBeenCalledWith("remote_read_file", expect.objectContaining({ path: "노트.md" }));
    });

    // CR.3 (RD1 empirical finding — DEVIATES from the design doc's prose,
    // §2.2 "workspace 선택으로 들어온 Global 볼트에서 등록된 permanent 루트
    // 아래 파일을 여는 경우 탭이 permanent 대신 global에 생긴다" claims that
    // OMITTING the vault arg (R1's else branch) currently lands the tab in
    // the OWNING permanent vault via path re-derivation, and would regress
    // to global if unified to pass an explicit vault. Empirically (this
    // test), once `routedVault` is explicitly "global" (routingTrustsCurrentVault
    // short-circuits `routeDocumentPath` — vault-routing.ts) it STAYS
    // trusted for every later in-place open, so a later click on a file
    // under a REGISTERED permanent vault's root — while browsing the Global
    // vault's (unlocked) filesystem tree with a document already open — also
    // lands in GLOBAL, not the permanent vault. This locks that observed
    // reality; reported as a design-vs-HEAD discrepancy in
    // _workspace/02_frontend_changes.md (does not block this refactor:
    // C7 preserves whichever behavior HEAD actually has, verbatim).
    it("CR.3: browsing Global (already routed+trusted) with a document open, clicking a file under a registered permanent vault's root still lands the tab in Global (path re-derivation does NOT kick in once global is trusted)", async () => {
      documentContents.set("/note.md", "# G");
      documentContents.set("/Q/x.md", "# Q");
      localStorage.setItem("mermark.workspaceState", JSON.stringify({
        workspaces: [{ workspaceId: "workspace-default", vaultIds: [permanentVaultId("/Q")], currentVaultId: "vault-global", lastSelectedPermanentVaultId: permanentVaultId("/Q") }],
        vaults: [{ vaultId: permanentVaultId("/Q"), workspaceId: "workspace-default", displayName: "Q", rootPath: "/Q", persistenceKind: "permanent", explorerRoot: "/Q" }],
        currentWorkspaceId: "workspace-default",
      }));
      dirListing.set("/", [{ name: "Q", path: "/Q", is_dir: true }]);
      dirListing.set("/Q", [{ name: "x.md", path: "/Q/x.md", is_dir: false }]);
      vi.stubGlobal("location", { search: "?file=/note.md" });

      await import("../src/main");
      await vi.waitFor(() => expect(cmText()).toBe("G"));
      document.querySelector<HTMLButtonElement>(".explorer-btn")?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-dir[data-path="/Q"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.explorer-dir[data-path="/Q"]')?.click();
      await vi.waitFor(() => expect(document.querySelector('.explorer-file[data-path="/Q/x.md"]')).not.toBeNull());
      document.querySelector<HTMLElement>('.explorer-file[data-path="/Q/x.md"]')?.click();
      await vi.waitFor(() => expect(cmText()).toBe("Q"));

      document.querySelector<HTMLButtonElement>(".workspace-btn")?.click();
      expect(document.querySelector('[data-vault-id="vault-global"] .workspace-vault-select')?.getAttribute("aria-current")).toBe("true");
      expect(document.querySelector(`[data-vault-id="${permanentVaultId("/Q")}"] .workspace-vault-select`)?.getAttribute("aria-current")).toBe("false");
      // Global-scoped tabs are session-only (tabScopeForVault) — never
      // persisted — so Q's own (permanent, persisted) tab list staying empty
      // is the observable proof the tab landed in Global, not Q.
      expect(localStorage.getItem(`mermark.vaultTabs.${permanentVaultId("/Q")}`)).toBeNull();
    });
  });
});

describe("document-transactions.test.ts — main.ts source shape (sanity, not a duplicate of main-wiring.test.ts)", () => {
  // C2-C6: all four transactions (T1 openDocument/openDocumentSafely, T2
  // enterVaultWelcome, T3 closeActiveTab, T4 navigateHistory/goBack/
  // goForward) have folded into src/document/session.ts. main.ts keeps
  // call-site-unchanged adapters for T1 (design §3.2) and thin handler
  // wiring for T2-T4; none of the four bodies live in main.ts anymore.
  it("reads T1's adapters from src/main.ts, and every transaction's real body from session.ts", () => {
    expect(mainSource).toContain("session.openDocument(absPath, { vault: targetVault });");
    expect(mainSource).toContain("session.openDocumentSafely(absPath, { onCommit, vault: targetVault });");
    const sessionSource = readFileSync("src/document/session.ts", "utf8");
    expect(sessionSource).toContain("async function openDocument(");
    expect(sessionSource).toContain("async function enterVaultWelcome(");
    expect(sessionSource).toContain("async function closeActiveTab(");
    expect(sessionSource).toContain("async function navigateHistory(");
  });
});
