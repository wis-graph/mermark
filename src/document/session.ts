// DocumentSession — the "currently open document" transaction owner main.ts
// used to inline as ~15 mutable cells + 4 hand-copied open transactions
// (_workspace/01_architect_design.md, riffactor B). C2 (this file's first
// landing) moves T1 (openDocument/openDocumentSafely) and its supporting
// cells/functions VERBATIM — deps are destructured under the SAME names
// main.ts used, so the moved bodies read byte-identical to what main.ts
// inlined before (design §3.1: "옮긴 코드가 글자 그대로 유지되게 한다").
//
// T2 (onSelectVault welcome)/T3 (onCloseTab)/T4 (navigateHistory) still live
// in main.ts at this commit — they reach this session's private lifecycle
// counter through a TRANSITIONAL API (`beginLifecycleRequest`/
// `isCurrentRequest`/`watcherHandoff`/`openInWindow`, all `@internal
// transitional`) until C4/C5/C6 fold each of them into a session method and
// that API is removed (C6 also deletes the now-unused exports).
//
// A closure factory, not a class (design §0's own reasoning): several call
// sites hand a session METHOD to another function as a bare value
// (`installAutoRestartOnUpdate(session.commitBeforeSwitch)`-shaped calls) —
// a class method passed that way loses its `this` binding, a closure
// doesn't.
import type { Extension } from "@codemirror/state";
import { fileHostFor } from "../document/file-host";
import { mountEditor, type EditorController, type SaveStatus } from "../editor";
import {
  createWatcherHandoff,
  watchFile,
  unwatchFile,
  type WatchSession,
} from "../document/file-watch";
import { isRemoteVault } from "../document/document-vault";
import { resolveTargetVault, tabScopeForVault } from "../workspace/vault-routing";
import { pushRecent } from "../sidebar/recent/recent-docs";
import {
  recentDocsSetting,
  modeSetting,
  autosaveDelaySetting,
  conflictPolicySetting,
  vimModeSetting,
} from "../settings/app";
import type { Vault, WorkspaceStore } from "../workspace/workspace-state";
import type { VaultTabStore } from "../workspace/vault-tabs";

export interface OpenOptions {
  /** An explicit target vault. Omitted = read falls back to `currentVault()
   *  ?? global`, and mount re-derives the vault by path (`routeDocumentPath`)
   *  — see D8/RD1 in the design doc. */
  readonly vault?: Vault;
  readonly onCommit?: () => void;
}

/** The mountEditor callbacks main.ts's own chrome (save status, outline
 *  listener, replace-hint) supplies. `onStatus`/`extraExtensions`/
 *  `findReplaceHint` are used exactly as HEAD's mountEditor call used them;
 *  `onCursorChrome` is only the CHROME half of the old inline `onCursor` —
 *  the session appends its own `saveSessionState()` call after it (HEAD's
 *  order: pos text updates, THEN session state saves). Called fresh on every
 *  mount (a getter, not a captured value) so a late keybinding rebind is
 *  reflected in the very next open. */
export interface EditorChromeOptions {
  readonly onStatus: (status: SaveStatus, detail?: string) => void;
  readonly onCursorChrome: (line: number, col: number) => void;
  readonly extraExtensions: Extension | undefined;
  readonly findReplaceHint: () => { chordLabel: string; activate: () => void };
}

export interface DocumentSessionDeps {
  readonly host: HTMLElement;
  readonly workspaceStore: WorkspaceStore;
  readonly vaultTabs: VaultTabStore;
  readonly currentVault: () => Vault | undefined;
  readonly routeDocumentPath: (path: string) => Vault;
  readonly setRoutedVault: (vault: Vault | undefined) => void;
  readonly initialFile: string;
  readonly initialBaseDir: string;
  // Overlay/recovery — delegated to whichever module still owns them (main,
  // until recovery-flow/external-change-flow are extracted in a LATER
  // bundle — design §4).
  readonly closeConflict: () => void;
  readonly closeOpenViewer: () => void;
  readonly closeRecovery: () => void;
  readonly hasOpenRecovery: () => boolean;
  readonly showDocumentRecovery: (kind: "deleted" | "unreadable" | "save", detail: string) => void;
  readonly showOpenRecovery: (path: string, detail: string, vault?: Vault) => void;
  // Mount chrome — same call site HEAD's openInWindow used.
  readonly baseDirForOpenedDocument: (file: string, vault: Vault | undefined) => string;
  readonly editorOptions: () => EditorChromeOptions;
  readonly onDocumentMounted: () => void; // = syncModeIndicator (HEAD's openInWindow position)
  readonly onDocumentShown: (file: string) => void; // = outline.refresh(); syncExplorerToOpenedDocument(file)
  // welcome
  readonly welcomeElement: () => HTMLElement;
  readonly welcomeBaseDir: (vault: Vault | undefined) => string; // baseDirForVault
  readonly onWelcomeCleared: () => void; // explorer.setActiveFile(null)
  readonly explorerFolder: () => string; // currentExplorerFolder — reload URL only, C7
  // T3/T4 still live in main.ts (C2-C5/C6) — openInWindow needs their
  // pre-fetched `fresh` payload mounted without re-reading, and its own
  // history push needs main's still-resident navHistory/recordNavigation
  // (that cell/function moves in C6, alongside T4 itself).
  readonly recordNavigation: (file: string, vaultId: string, viaHistory: boolean) => void;
}

export interface DocumentSession {
  readonly current: EditorController | undefined;
  readonly currentFile: string;
  readonly currentBaseDir: string;
  readonly currentIsRemote: boolean;
  readonly currentOpenVaultId: string | null;

  openDocument(absPath: string, opts?: OpenOptions): Promise<boolean>;
  openDocumentSafely(absPath: string, opts?: OpenOptions): Promise<boolean>;

  commitBeforeSwitch(): Promise<boolean>;
  renderWelcomeForVault(): void;
  saveSessionState(immediate?: boolean): void;
  acceptsWatchEvent(change: Pick<WatchSession, "path" | "generation">): boolean;

  /** @internal transitional — removed in C6 once T4 folds into goBack/goForward
   *  and the negative main-source guard lands. */
  beginLifecycleRequest(): number;
  /** @internal transitional — removed in C6 (see beginLifecycleRequest). */
  isCurrentRequest(id: number): boolean;
  /** @internal transitional — removed in C6 (see beginLifecycleRequest). T2/T3
   *  (still main-resident) call `.handoff(...)` directly until they fold. */
  readonly watcherHandoff: ReturnType<typeof createWatcherHandoff>;
  /** @internal transitional — removed once T3 (C5) and T4 (C6) fold and stop
   *  needing to mount an already-fetched `fresh` payload themselves. */
  openInWindow(
    file: string,
    fresh: { text: string; mtime: number },
    opts?: { readonly viaHistory?: boolean },
    targetVault?: Vault,
  ): void;
}

export function createDocumentSession(deps: DocumentSessionDeps): DocumentSession {
  const { host, workspaceStore, vaultTabs, currentVault, routeDocumentPath, setRoutedVault } = deps;

  // "Currently open document" — the single source of truth for which editor /
  // file / baseDir is live. All window-global sinks and listeners read this
  // mutable cell; openInWindow re-points it. No second copy of "which file".
  let current: EditorController | undefined;
  let currentFile = deps.initialFile ?? "";
  let currentBaseDir = deps.initialBaseDir;
  let currentIsRemote = false;
  let currentOpenVaultId: string | null = null;

  // The per-file teardown closures the previous openInWindow installed (scroll
  // listener, pending session timer). teardownCurrent runs them before swap.
  let detachScroll: (() => void) | undefined;
  let cancelSessionTimer: (() => void) | undefined;
  let lifecycleRequest = 0;
  let pendingPrepare: { readonly editor: EditorController; readonly file: string; readonly promise: Promise<boolean> } | null = null;
  const watcherHandoff = createWatcherHandoff({ watch: watchFile, unwatch: unwatchFile }, (phase, error) => {
    const label = phase === "detach" ? "detach" : phase === "attach" ? "attach" : "rollback";
    if (error instanceof Error) console.error(`File watcher ${label} failed`, error.message);
    else console.error(`File watcher ${label} failed`, String(error));
  });
  const beginLifecycleRequest = (): number => {
    watcherHandoff.invalidate();
    lifecycleRequest += 1;
    return lifecycleRequest;
  };
  const isCurrentRequest = (id: number): boolean => id === lifecycleRequest;
  const acceptsWatchEvent = (change: Pick<WatchSession, "path" | "generation">): boolean =>
    watcherHandoff.accepts(change, currentFile);

  /** A single stale-request check, captured once per transaction (design
   *  §3.3) — replaces the old `requestId !== lifecycleRequest` hand-copy at
   *  every T1/T2/T3/T4 call site with one comparable object. Built on TOP of
   *  `beginLifecycleRequest`/`isCurrentRequest` (the transitional API T2/T3
   *  still use directly until they fold) — same counter, same
   *  `watcherHandoff.invalidate()` side effect, so a stale T1 token and a
   *  stale raw `requestId` number can never disagree about which request is
   *  current. */
  interface RequestToken { isCurrent(): boolean }
  const beginToken = (): RequestToken => {
    const id = beginLifecycleRequest();
    return { isCurrent: () => isCurrentRequest(id) };
  };

  /** The open-transaction primitive (design §3.4) every T1/T2/T3/T4 spec
   *  re-expresses onto: read (if any) → stale-check → commitBeforeSwitch →
   *  stale-check → handoff → stale-check → commit, aborting (with an
   *  optional resumeWrites) the moment staleness is detected. Control flow
   *  is byte-for-byte what T1's hand-written body used to do — see the
   *  design doc's "제어 흐름 동치성 체크리스트" this re-expression was
   *  checked against:
   *  1. token is created at the SAME point the old `requestId` default
   *     parameter was (call time, before read).
   *  2. `sourceEditor` is captured by the CALLER before this runs (not by
   *     runTransition itself — it needs the value from the exact same
   *     synchronous tick the token was minted in).
   *  3. read failure: current token → `onReadError` (T1 rethrows); stale →
   *     silently `false`, `onReadError` never called.
   *  4. `!token.isCurrent() || !(await commitBeforeSwitch()) || !token.isCurrent()`
   *     — short-circuits on the FIRST stale check without ever calling
   *     commitBeforeSwitch (same `||` short-circuit HEAD's raw comparison had).
   *  5. handoff only runs if step 4 passed; re-checked stale after it too.
   *  6. abort resumes writes only when `resumeOnAbort` AND the mounted editor
   *     is STILL the one this transaction started from (`current === sourceEditor`)
   *     — a swap that already happened via a different transaction must not
   *     be resumed by this one's late abort.
   *  7. `commit(fresh)` runs synchronously (no await between it and the
   *     handoff check) — callers pack the old `onCommit?.(); openInWindow(...)`
   *     pair straight into `commit`. */
  async function runTransition<F>(spec: {
    readonly token: RequestToken;
    readonly sourceEditor: EditorController | undefined;
    readonly read?: () => Promise<F>;
    readonly onReadError: (error: unknown) => "abort-silently";
    readonly resumeOnAbort: boolean;
    readonly handoff: () => Promise<boolean>;
    readonly commit: (fresh: F | undefined) => void;
  }): Promise<boolean> {
    const abort = (): boolean => {
      if (spec.resumeOnAbort && spec.sourceEditor && current === spec.sourceEditor) spec.sourceEditor.resumeWrites();
      return false;
    };
    let fresh: F | undefined;
    if (spec.read) {
      try {
        fresh = await spec.read();
      } catch (error: unknown) {
        if (spec.token.isCurrent()) spec.onReadError(error); // may throw (T1's "rethrow" policy)
        return false;
      }
    }
    if (!spec.token.isCurrent() || !(await commitBeforeSwitch()) || !spec.token.isCurrent()) return abort();
    if (!(await spec.handoff()) || !spec.token.isCurrent()) return abort();
    spec.commit(fresh);
    return true;
  }

  /** The localStorage key `mermark.session.*` state is keyed by — ONE named
   *  function so the save site and the restore site (both below) can never
   *  drift onto two different key shapes. `vaultId ?? ""` keeps a legacy/no-
   *  vault key stable in shape (still 4 dot-segments after the prefix would
   *  change grep-ability for no benefit) while still disambiguating from a
   *  DIFFERENT vault's same-named file, which is the actual bug this exists
   *  to close. */
  function sessionStateKey(vaultId: string | null, file: string): string {
    return `mermark.session.${vaultId ?? ""}.${file}`;
  }

  // ── Per-file session persistence. The key is recomputed per open; the timer
  //    is scoped to the live editor and cancelled on teardown. ────────────────
  function saveSessionState(immediate = false): void {
    cancelSessionTimer?.();
    const doSave = () => {
      if (!current) return;
      const scroller = host.querySelector(".cm-scroller");
      const scroll = scroller ? scroller.scrollTop : 0;
      const cursor = current.view.state.selection.main.anchor;
      try {
        localStorage.setItem(sessionStateKey(currentOpenVaultId, currentFile), JSON.stringify({ scroll, cursor }));
      } catch (err) {
        console.error("Failed to save session state to localStorage", err);
      }
    };
    if (immediate) {
      cancelSessionTimer = undefined;
      doSave();
    } else {
      const t = setTimeout(doSave, 150);
      cancelSessionTimer = () => {
        clearTimeout(t);
        cancelSessionTimer = undefined;
      };
    }
  }

  /** Persist any unsaved buffer BEFORE switching files, so a re-open never
   *  drops edits. On conflict, saveOnClose writes the `.mermark-recovered`
   *  sibling, so neither the edits nor the external change are lost. Named so
   *  the "don't lose work on switch" rule lives in one place. */
  async function commitBeforeSwitch(): Promise<boolean> {
    if (!current) return true;
    if (!current.hasUnsaved()) return true;
    const editor = current;
    const file = currentFile;
    if (pendingPrepare?.editor === editor && pendingPrepare.file === file) return pendingPrepare.promise;
    editor.beginClose();
    const promise = editor.saveOnClose().then((saved) => {
      if (!saved && current === editor && currentFile === file) {
        editor.resumeWrites();
        if (!deps.hasOpenRecovery()) deps.showDocumentRecovery("save", "전환 전에 저장하지 못했습니다");
      }
      return saved;
    }).finally(() => {
      if (pendingPrepare?.promise === promise) pendingPrepare = null;
    });
    pendingPrepare = { editor, file, promise };
    return promise;
  }

  /** Tear down the live editor before a swap: persist its session immediately,
   *  stop its autosave (beginClose), detach its scroll listener + session timer,
   *  then drop its CM DOM. Leaves host empty for the next mount. */
  function teardownCurrent(): void {
    if (current) {
      saveSessionState(true);
      current.beginClose();
      detachScroll?.();
      detachScroll = undefined;
      cancelSessionTimer?.();
      cancelSessionTimer = undefined;
    }
    host.replaceChildren();
  }

  const renderWelcomeForVault = (): void => {
    deps.closeOpenViewer();
    deps.closeConflict();
    deps.closeRecovery();
    teardownCurrent();
    currentFile = "";
    deps.onWelcomeCleared(); // no document open — clear the tree highlight
    const vault = currentVault();
    currentBaseDir = deps.welcomeBaseDir(vault);
    host.classList.add("welcome-host");
    host.append(deps.welcomeElement());
  };

  function openInWindow(
    file: string,
    fresh: { text: string; mtime: number },
    opts: { readonly viaHistory?: boolean } = {},
    targetVault?: Vault,
  ): void {
    // `targetVault`, when the caller already knows it (a vault-crossing
    // open: onSelectVault/onSelectTab via openDocument above, or
    // navigateHistory below), wins over routeDocumentPath's own
    // path-based re-derivation — routeDocumentPath can only ever land on
    // "permanent"/"global" (see its own comment), so a remote target passed
    // explicitly would otherwise get silently reclassified. Explicitly
    // setting `routedVault` here covers navigateHistory, which has no
    // onCommit callback to have already done it (onSelectVault/onSelectTab's
    // onCommit already did, redundantly but harmlessly).
    const selectedVault = targetVault ?? routeDocumentPath(file);
    // Every real document open resolves SOME vault (permanent/global/remote —
    // routeDocumentPath/targetVault never return undefined); this is the
    // invariant mountEditor's documentVault facet relies on to never be
    // undefined for a genuinely open document. A cheap runtime guard (not
    // just a type) so a future change that loosens routeDocumentPath's
    // return type fails loudly here instead of quietly mounting a document
    // with no vault context.
    if (!selectedVault) throw new Error(`openInWindow: no vault resolved for "${file}"`);
    if (targetVault) setRoutedVault(targetVault);
    deps.closeConflict();
    deps.closeOpenViewer(); // opening a document closes any open viewer (design §A rule 1)
    teardownCurrent();
    host.classList.remove("welcome-host");
    currentFile = file;
    currentBaseDir = deps.baseDirForOpenedDocument(file, selectedVault);
    if (selectedVault) vaultTabs.open(selectedVault.vaultId, file, tabScopeForVault(selectedVault));
    const { text, mtime } = fresh;

    const chrome = deps.editorOptions();
    current = mountEditor(host, text, currentBaseDir, file, {
      onStatus: chrome.onStatus,
      initialMode: modeSetting.get(),
      onCursor: (line, col) => {
        chrome.onCursorChrome(line, col);
        saveSessionState();
      },
      baseMtime: mtime,
      autosaveDelay: autosaveDelaySetting.get(),
      conflictPolicy: conflictPolicySetting.get(),
      vimMode: vimModeSetting.get(),
      vault: selectedVault,
      // Outline panel's docChanged listener — re-attaches per mount, so the
      // outline tracks whichever document is currently live.
      extraExtensions: chrome.extraExtensions,
      // Search-panel replace-hint (v0.9.12/v0.9.13 defects) — replaceHintEntry
      // is defined below (registerHandler block) and shared with
      // search.document's initial ⌘F open; a getter (not a value) so a
      // keybindings rebind is reflected the next time a mode switch resyncs
      // an open panel. Safe forward reference: openInWindow (this call's
      // enclosing function) only ever RUNS after the registerHandler block
      // below has executed at boot.
      findReplaceHint: chrome.findReplaceHint,
    });
    currentIsRemote = isRemoteVault(selectedVault);
    currentOpenVaultId = selectedVault.vaultId;
    deps.onDocumentMounted();

    const scroller = host.querySelector(".cm-scroller");
    if (scroller) {
      const onScroll = () => saveSessionState();
      scroller.addEventListener("scroll", onScroll, { passive: true });
      detachScroll = () => scroller.removeEventListener("scroll", onScroll);
    }

    // Restore session state for this file's key.
    let savedSession: string | null = null;
    try {
      savedSession = localStorage.getItem(sessionStateKey(selectedVault.vaultId, file));
    } catch (err) {
      console.error("Failed to read session state from localStorage", err);
    }
    if (savedSession) {
      try {
        const { scroll, cursor } = JSON.parse(savedSession);
        if (typeof cursor === "number" && cursor >= 0 && cursor <= text.length) {
          current.view.dispatch({ selection: { anchor: cursor, head: cursor } });
        }
        if (typeof scroll === "number") {
          requestAnimationFrame(() => {
            const sc = host.querySelector(".cm-scroller");
            if (sc) sc.scrollTop = scroll;
          });
        }
      } catch (err: any) {
        console.error("Failed to restore session state", err);
      }
    }

    // No `!opts.watcherReady` fallback here (there used to be one): every
    // real caller of `openInWindow` already threads `watcherReady: true`
    // after having done its OWN `watcherHandoff.handoff` call first (final
    // review C2 found this branch dead — the guard it was gated behind never
    // actually fired). Watching (or skipping, for a remote vault) now
    // happens exactly once per open, at each of those call sites, gated
    // structurally by `handoff` itself via `shouldWatchDocument` — not
    // re-decided here from `selectedVault.persistenceKind` a second time.

    // Reconcile the outline + explorer tree/breadcrumb/highlight with the
    // newly-opened document (main.ts's syncExplorerToOpenedDocument, still
    // main-resident — see its own doc comment for the three-branch rule
    // "opening a document is not a navigation act").
    deps.onDocumentShown(file);

    // Record this document as most-recent — the SINGLE write point for the recent
    // list (dedup → front → cap via pushRecent). The recent panel re-renders from
    // its recentDocsSetting subscription; localStorage persists it across restarts.
    // `selectedVault.vaultId` rides along (Task 11 fix round 3) — without it a
    // remote document's vault-relative `file` ("노트.md") would be
    // indistinguishable from an unrelated local/other-remote entry, and
    // opening it later would have nothing to resolve the right backend from.
    recentDocsSetting.set(pushRecent(recentDocsSetting.get(), { path: file, vaultId: selectedVault.vaultId }));

    // Record the navigation in the back/forward history — the SAME single locus
    // as the recent write. A back/forward move (viaHistory) must NOT re-push (the
    // handler already moved the pointer), else ⌘[ would loop. Named so the "don't
    // re-record a history move" rule isn't an inline if. Still main-resident
    // until T4 folds (C6) — session calls through the injected dep.
    deps.recordNavigation(file, selectedVault.vaultId, opts.viaHistory ?? false);

    // dev-only: expose the live controller so the debug harness can read real
    // editor state (selection offsets, block specs) instead of guessing.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
      (window as unknown as { __mermark?: unknown }).__mermark = current;
  }

  // Ruling 9: `targetVault`, when the caller already knows it (onSelectVault/
  // onSelectTab — switching TO a specific tab's vault), is the vault the
  // READ must go through. Without it, `currentVault()` here is the vault of
  // whatever is STILL open (the switch's SOURCE, not its target) — onCommit
  // (which flips `routedVault` to the target) only runs AFTER this read
  // succeeds, so a vault-crossing open would read through the wrong
  // backend. Wikilink/standard-link clicks and recent/welcome-pane opens
  // never cross a vault boundary within one call, so the
  // `currentVault() ?? global` fallback is correct for them. CLI open (the
  // cli-open-request listener, the open-path prompt, the boot-time initial
  // file) is DIFFERENT: it now always threads an explicit `targetVault`
  // resolved by `openPathEntry` via `routeCliFile` — Task 11 fix round 2
  // found that leaning on this function's own fallback for those callers
  // read a raw local absolute path through `currentVault()` (the SIDEBAR's
  // selection), which is wrong whenever a remote vault happens to be
  // selected: `fileHostFor(remoteVault)` sent the local path to
  // `remote_read_file`, the host rejected it, and a perfectly valid local
  // file showed the open-failure recovery modal instead of opening.
  //
  // `opts.vault`/`opts.onCommit` destructure to the SAME local names
  // (`targetVault`/`onCommit`) HEAD's positional parameters used. `token` is
  // a third, non-public parameter (openDocumentSafely passes its own) — same
  // sharing mechanism HEAD's `requestId` default-parameter shape used, now a
  // `RequestToken` (design §3.3/§3.4) instead of a raw number, re-expressed
  // on top of `runTransition` — see that function's own doc comment for the
  // control-flow equivalence this re-expression was checked against.
  async function openDocument(
    absPath: string,
    opts: OpenOptions = {},
    token = beginToken(),
  ): Promise<boolean> {
    const targetVault = opts.vault;
    const onCommit = opts.onCommit;
    const sourceEditor = current;
    const readVault = resolveTargetVault(targetVault, currentVault(), workspaceStore.getGlobalVault());
    return runTransition<{ text: string; mtime: number }>({
      token,
      sourceEditor,
      read: async () => { return fileHostFor(readVault).readFile(absPath); },
      onReadError: (error) => { throw error; }, // T1's "rethrow" policy (D4)
      resumeOnAbort: true, // T1's D5
      handoff: () => watcherHandoff.handoff(absPath, readVault),
      commit: (freshValue) => {
        const fresh = freshValue as { text: string; mtime: number };
        onCommit?.();
        openInWindow(absPath, fresh, {}, targetVault);
      },
    });
  }
  function openDocumentSafely(absPath: string, opts: OpenOptions = {}): Promise<boolean> {
    const token = beginToken();
    return openDocument(absPath, opts, token).catch((error: unknown) => {
      if (token.isCurrent()) deps.showOpenRecovery(absPath, String(error), opts.vault);
      return false;
    });
  }

  return {
    get current() { return current; },
    get currentFile() { return currentFile; },
    get currentBaseDir() { return currentBaseDir; },
    get currentIsRemote() { return currentIsRemote; },
    get currentOpenVaultId() { return currentOpenVaultId; },

    openDocument,
    openDocumentSafely,

    commitBeforeSwitch,
    renderWelcomeForVault,
    saveSessionState,
    acceptsWatchEvent,

    beginLifecycleRequest,
    isCurrentRequest,
    watcherHandoff,
    openInWindow,
  };
}
