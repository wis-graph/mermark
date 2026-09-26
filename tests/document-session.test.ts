// Unit-level tests for DocumentSession's own control-flow primitive
// (runTransition/RequestToken, design §3.3/§3.4) — exercised through
// openDocument/openDocumentSafely (the only public transaction that exists
// at C3) against a MINIMAL, hand-built session (no full main.ts boot, no
// real CodeMirror/DOM editor — `../src/editor`'s mountEditor is mocked so
// this file stays fast and independent of the app's boot graph).
//
// This complements tests/document-transactions.test.ts (which already
// exercises the SAME control flow end-to-end through a real boot + real UI
// clicks — C1.1-C1.7 cover the stale-race/resumeWrites/onCommit properties
// this file checks). The value here is a narrower, faster surface that pins
// runTransition's contract independent of main.ts's wiring, so a future
// change to T2/T3/T4's own specs (C4/C5/C6) can be checked against the SAME
// primitive without re-running a full boot.
//
// NOT covered here (deferred to when the relevant public method exists):
// "read 없으면 commitBeforeSwitch가 동기로 시작" needs enterVaultWelcome
// (T2, C4) — openDocument always has a `read`. Readonly-view guards are C8.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentSession, type DocumentSessionDeps } from "../src/document/session";
import { WorkspaceStore } from "../src/workspace/workspace-state";
import { VaultTabStore } from "../src/workspace/vault-tabs";

// ── fake EditorController (no real CodeMirror). No explicit return-type
//    annotation — that would widen every vi.fn() property back down to the
//    interface's plain function type and lose `.mockClear()`/call-count
//    access at test call sites. Structural compatibility with
//    `EditorController` (needed wherever this is assigned to `nextEditor`)
//    is still checked, just inferred rather than declared. ────────────────
function makeFakeEditor() {
  let unsaved = false;
  let saveOnCloseResult = true;
  const log: string[] = [];
  return {
    log,
    setUnsaved: (v: boolean) => { unsaved = v; },
    setSaveOnCloseResult: (v: boolean) => { saveOnCloseResult = v; },
    // Minimal shape saveSessionState's doSave() touches
    // (view.state.selection.main.anchor) — a bare `{}` throws there.
    view: { state: { selection: { main: { anchor: 0 } } }, dispatch: vi.fn() } as any,
    mode: () => "edit",
    setMode: vi.fn(),
    refresh: vi.fn(),
    reloadFeatures: vi.fn(),
    hasUnsaved: () => unsaved,
    suspendWrites: vi.fn(),
    retryOriginal: vi.fn(async () => true),
    saveRecoveredCopy: vi.fn(async () => true),
    saveAs: vi.fn(async () => true),
    resumeWrites: vi.fn(() => { log.push("resumeWrites"); }),
    forceSave: vi.fn(),
    beginClose: vi.fn(() => { log.push("beginClose"); }),
    saveOnClose: vi.fn(async () => { log.push("saveOnClose"); return saveOnCloseResult; }),
    setAutosaveDelay: vi.fn(),
    setConflictPolicy: vi.fn(),
    setVimMode: vi.fn(),
    reloadFromFile: vi.fn(),
    flushSave: vi.fn(),
  };
}

let nextEditor: ReturnType<typeof makeFakeEditor> | undefined;
const mountEditorMock = vi.fn((..._args: unknown[]) => {
  const editor = nextEditor ?? makeFakeEditor();
  nextEditor = undefined;
  return editor;
});
vi.mock("../src/editor", () => ({
  mountEditor: (...args: unknown[]) => mountEditorMock(...args),
}));

// ── minimal invoke mock (read_file/watch_file/unwatch_file only) ────────
const documentContents = new Map<string, string>();
const deferredReads = new Map<string, { promise: Promise<unknown> }>();
const rejectedReads = new Set<string>();
let rejectWatch = false;
const invokeMock = vi.fn((command: string, args?: unknown): Promise<unknown> => {
  const path = (args as { path?: string } | undefined)?.path ?? "";
  if (command === "read_file") {
    if (rejectedReads.has(path)) return Promise.reject(new Error("read failed"));
    const deferred = deferredReads.get(path);
    if (deferred) return deferred.promise;
    return Promise.resolve({ text: documentContents.get(path) ?? "# doc", mtime: 1 });
  }
  if (command === "watch_file") {
    if (rejectWatch) return Promise.reject(new Error("watch failed"));
    return Promise.resolve({ path, generation: "1" });
  }
  if (command === "unwatch_file") return Promise.resolve();
  return Promise.resolve(false);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

function makeDeps(overrides: Partial<DocumentSessionDeps> = {}): DocumentSessionDeps {
  const workspaceStore = new WorkspaceStore();
  const vaultTabs = new VaultTabStore();
  const globalVault = workspaceStore.getGlobalVault();
  return {
    host: document.createElement("div"),
    workspaceStore,
    vaultTabs,
    currentVault: () => globalVault,
    routeDocumentPath: () => globalVault,
    setRoutedVault: vi.fn(),
    initialFile: "",
    initialBaseDir: "/",
    closeConflict: vi.fn(),
    closeOpenViewer: vi.fn(),
    closeRecovery: vi.fn(),
    hasOpenRecovery: () => false,
    showDocumentRecovery: vi.fn(),
    showOpenRecovery: vi.fn(),
    baseDirForOpenedDocument: () => "/",
    editorOptions: () => ({
      onStatus: vi.fn(),
      onCursorChrome: vi.fn(),
      extraExtensions: undefined,
      findReplaceHint: () => ({ chordLabel: "", activate: vi.fn() }),
    }),
    onDocumentMounted: vi.fn(),
    onDocumentShown: vi.fn(),
    welcomeElement: () => document.createElement("div"),
    welcomeBaseDir: () => "/",
    onWelcomeCleared: vi.fn(),
    explorerFolder: () => "/",
    recordNavigation: vi.fn(),
    ...overrides,
  };
}

describe("DocumentSession — runTransition contract (via openDocument/openDocumentSafely)", () => {
  beforeEach(() => {
    documentContents.clear();
    deferredReads.clear();
    rejectedReads.clear();
    rejectWatch = false;
    invokeMock.mockClear();
    mountEditorMock.mockClear();
    nextEditor = undefined;
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("commits onCommit exactly once, and only right before the mount (no await between them)", async () => {
    documentContents.set("/a.md", "# A");
    const session = createDocumentSession(makeDeps());
    const order: string[] = [];
    const onCommit = vi.fn(() => order.push("onCommit"));
    mountEditorMock.mockImplementationOnce((..._args) => { order.push("mounted"); return makeFakeEditor(); });

    const ok = await session.openDocument("/a.md", { onCommit });

    expect(ok).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["onCommit", "mounted"]);
    expect(session.currentFile).toBe("/a.md");
  });

  it("never calls onCommit when the read fails (current request — rethrows instead)", async () => {
    rejectedReads.add("/missing.md");
    const session = createDocumentSession(makeDeps());
    const onCommit = vi.fn();

    await expect(session.openDocument("/missing.md", { onCommit })).rejects.toThrow("read failed");
    expect(onCommit).not.toHaveBeenCalled();
    expect(session.currentFile).toBe("");
  });

  it("openDocumentSafely swallows the SAME read failure instead of rethrowing, and shows recovery only while the request is still current", async () => {
    rejectedReads.add("/missing.md");
    const showOpenRecovery = vi.fn();
    const session = createDocumentSession(makeDeps({ showOpenRecovery }));

    const ok = await session.openDocumentSafely("/missing.md");

    expect(ok).toBe(false);
    expect(showOpenRecovery).toHaveBeenCalledTimes(1);
    expect(showOpenRecovery).toHaveBeenCalledWith("/missing.md", expect.stringContaining("read failed"), undefined);
  });

  it("a stale request's read failure is swallowed silently — no recovery shown, no rethrow reaches the caller", async () => {
    documentContents.set("/b.md", "# B");
    let rejectA: (() => void) | undefined;
    deferredReads.set("/a.md", { promise: new Promise((_resolve, reject) => { rejectA = () => reject(new Error("a failed")); }) });
    const showOpenRecovery = vi.fn();
    const session = createDocumentSession(makeDeps({ showOpenRecovery }));

    const pendingA = session.openDocumentSafely("/a.md"); // stays pending
    await session.openDocumentSafely("/b.md"); // invalidates A's token, then succeeds
    rejectA?.();
    const resultA = await pendingA;

    expect(resultA).toBe(false);
    expect(showOpenRecovery).not.toHaveBeenCalled();
    expect(session.currentFile).toBe("/b.md");
  });

  it("short-circuits on staleness BEFORE running commitBeforeSwitch (no extra beginClose/saveOnClose on the mounted editor)", async () => {
    documentContents.set("/a.md", "# A");
    documentContents.set("/b.md", "# B");
    documentContents.set("/c.md", "# C");
    const editorA = makeFakeEditor();
    editorA.setUnsaved(true); // dirty — commitBeforeSwitch would call beginClose/saveOnClose if reached
    nextEditor = editorA;
    const session = createDocumentSession(makeDeps());
    await session.openDocumentSafely("/a.md");
    expect(session.currentFile).toBe("/a.md");

    let resolveB: ((v: unknown) => void) | undefined;
    deferredReads.set("/b.md", { promise: new Promise((resolve) => { resolveB = resolve; }) });
    const pendingB = session.openDocumentSafely("/b.md"); // read pending — A still current, still dirty
    await session.openDocumentSafely("/c.md"); // completes first, invalidates B's token
    editorA.beginClose.mockClear();
    editorA.saveOnClose.mockClear();
    resolveB?.({ text: "# B", mtime: 1 });
    const resultB = await pendingB;

    expect(resultB).toBe(false);
    // B's transaction reached the read successfully, but was stale by the
    // time it checked in — commitBeforeSwitch (which would touch the LIVE
    // editor's beginClose/saveOnClose) must never have run for it.
    expect(editorA.beginClose).not.toHaveBeenCalled();
    expect(editorA.saveOnClose).not.toHaveBeenCalled();
    expect(session.currentFile).toBe("/c.md");
  });

  it("resumes writes on abort only when the mounted editor is STILL the one this transaction started from", async () => {
    documentContents.set("/a.md", "# A");
    documentContents.set("/b.md", "# B");
    const editorA = makeFakeEditor();
    editorA.setUnsaved(true);
    editorA.setSaveOnCloseResult(true);
    nextEditor = editorA;
    const session = createDocumentSession(makeDeps());
    await session.openDocumentSafely("/a.md");
    rejectWatch = true; // handoff (watch attach) fails for every open FROM HERE on

    const ok = await session.openDocumentSafely("/b.md"); // dirty save succeeds, then watch fails -> abort

    expect(ok).toBe(false);
    expect(session.currentFile).toBe("/a.md"); // never swapped
    expect(editorA.resumeWrites).toHaveBeenCalledTimes(1); // current === sourceEditor at abort time
  });
});
