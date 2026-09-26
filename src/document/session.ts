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
import { selectVaultView, type TabPersistenceScope, type VaultTab, type VaultTabStore } from "../workspace/vault-tabs";
import { makeHistory, pushHistory, back, forward, currentEntry, pruneAt, type NavHistory } from "../document/history/nav-history";
import { createDocumentReloadUrl } from "../workspace/reload-handoff";

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
}

export interface DocumentSession {
  readonly current: EditorController | undefined;
  readonly currentFile: string;
  readonly currentBaseDir: string;
  readonly currentIsRemote: boolean;
  readonly currentOpenVaultId: string | null;

  openDocument(absPath: string, opts?: OpenOptions): Promise<boolean>;
  openDocumentSafely(absPath: string, opts?: OpenOptions): Promise<boolean>;
  openFromPanel(path: string, opts: { panelVault: Vault | undefined; vault?: Vault }): Promise<boolean>;
  enterVaultWelcome(opts: { onCommit: () => void; onRendered?: () => void }): Promise<void>;
  closeActiveTab(vault: Vault, tab: VaultTab, scope: TabPersistenceScope): Promise<void>;
  goBack(): void;
  goForward(): void;

  commitBeforeSwitch(): Promise<boolean>;
  renderWelcomeForVault(): void;
  saveSessionState(immediate?: boolean): void;
  acceptsWatchEvent(change: Pick<WatchSession, "path" | "generation">): boolean;

  /** Read-only, future-plugin-API-shaped view (design §3.6 — structurally
   *  the same shape `src/api`'s `ReadonlySetting<T>` uses, so a later
   *  plugin-API exposure is a straight re-export, not a redesign). No
   *  editor handle, no transaction, no setter — a frozen snapshot plus
   *  subscribe/bind. Not exposed through `src/api` yet; that's the
   *  plugin-API work itself (design §3.4/§5), out of scope for this
   *  bundle. session.ts deliberately never imports `src/api` (api →
   *  registries is the one-way dependency direction that module owns; this
   *  file only defines the SHAPE api/ will one day re-export). */
  readonly readonlyView: ReadonlyDocumentView;
}

export interface DocumentSnapshot {
  readonly file: string;
  readonly baseDir: string;
  readonly isRemote: boolean;
  readonly vaultId: string | null;
}

export interface ReadonlyDocumentView {
  get(): DocumentSnapshot;
  subscribe(fn: (s: DocumentSnapshot) => void): () => void;
  bind(fn: (s: DocumentSnapshot) => void): () => void;
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

  // ── Read-only view (design §3.6) — a frozen snapshot + subscribe/bind, no
  //    editor handle, no transaction, no setter. Notified from exactly two
  //    points: the end of openInWindow (a document mounted) and the end of
  //    renderWelcomeForVault (no document open). No subscriber exists inside
  //    the app today, so this changes zero observable behavior on its own.
  const snapshotListeners = new Set<(snapshot: DocumentSnapshot) => void>();
  const snapshot = (): DocumentSnapshot =>
    Object.freeze({ file: currentFile, baseDir: currentBaseDir, isRemote: currentIsRemote, vaultId: currentOpenVaultId });
  const notifySnapshot = (): void => {
    const s = snapshot();
    for (const fn of snapshotListeners) fn(s);
  };
  const readonlyView: ReadonlyDocumentView = Object.freeze({
    get: snapshot,
    subscribe: (fn: (s: DocumentSnapshot) => void) => {
      snapshotListeners.add(fn);
      return () => snapshotListeners.delete(fn);
    },
    bind: (fn: (s: DocumentSnapshot) => void) => {
      fn(snapshot());
      snapshotListeners.add(fn);
      return () => snapshotListeners.delete(fn);
    },
  });

  /** A single stale-request check, captured once per transaction (design
   *  §3.3) — replaces the old `requestId !== lifecycleRequest` hand-copy at
   *  every T1/T2/T3/T4 call site with one comparable object. Built on TOP of
   *  `beginLifecycleRequest`/`isCurrentRequest` — same counter, same
   *  `watcherHandoff.invalidate()` side effect. */
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
   *     pair straight into `commit`.
   *  8. `guard` (BC-3, C11) is an OPTIONAL extra abort condition checked
   *     right before `commit`, on top of (not instead of) the token
   *     staleness checks above — for a mismatch ordinary token staleness
   *     can't see at all (design §2.4's BC-3: an inactive tab close bypasses
   *     the lifecycle counter entirely, so the ACTIVE tab's own close can
   *     still look "current" while the tab list it's about to act on has
   *     silently changed underneath it). Most transactions don't need one. */
  async function runTransition<F>(spec: {
    readonly token: RequestToken;
    readonly sourceEditor: EditorController | undefined;
    readonly read?: () => Promise<F>;
    /** Required iff `read` is given — nothing to fail without a read. */
    readonly onReadError?: (error: unknown) => "abort-silently";
    readonly resumeOnAbort: boolean;
    readonly handoff: () => Promise<boolean>;
    readonly guard?: () => boolean;
    /** Called ONLY when `guard` fails AFTER `handoff` already succeeded (the
     *  narrow window where the interference that breaks `guard` arrives
     *  mid-handoff, audit 🟡-1) — re-points whatever `handoff` just attached
     *  back to the document that's actually STILL mounted (this transaction
     *  never reaches `commit`, so nothing else will fix this up). Awaited
     *  before the abort's resumeWrites so watcherHandoff's own internal
     *  queue serializes cleanly (no watch left targeting a closed tab). */
    readonly restoreAfterHandoff?: () => Promise<boolean>;
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
        if (spec.token.isCurrent()) spec.onReadError?.(error); // may throw (T1's "rethrow" policy)
        return false;
      }
    }
    if (!spec.token.isCurrent() || !(await commitBeforeSwitch()) || !spec.token.isCurrent()) return abort();
    // `guard` is checked BEFORE handoff too (not just after, below) — the
    // dominant BC-3 race (an interference that lands during the read/
    // commitBeforeSwitch wait) is caught here, before ever touching the
    // watcher at all (audit 🟡-1's "지배적 경로").
    if (spec.guard && !spec.guard()) return abort();
    if (!(await spec.handoff()) || !spec.token.isCurrent()) return abort();
    if (spec.guard && !spec.guard()) {
      await spec.restoreAfterHandoff?.();
      return abort();
    }
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
    notifySnapshot();
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
    // re-record a history move" rule isn't an inline if.
    recordNavigation(file, selectedVault.vaultId, opts.viaHistory ?? false);

    notifySnapshot();

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

  /** R1 (explorer)/R2 (recent)/R3 (search) — the SAME reload-vs-in-place rule
   *  body all three panels hand-copied (design §2.2): with no document open
   *  yet AND the panel's own vault isn't remote, reload the whole page
   *  (`createDocumentReloadUrl`) rather than mount in place — a remote
   *  vault has no way to encode itself in the reload URL (§2.2's RD3), so it
   *  always opens in place regardless of `currentFile`. `vault` (mount) is
   *  deliberately SEPARATE from `panelVault` (only used for this decision):
   *  R1 omits it for a non-remote in-place open (RD1 — path re-derivation,
   *  see openInWindow's own comment), R2/R3 always pass their own entry/scan
   *  vault explicitly (RD2). */
  async function openFromPanel(path: string, opts: { panelVault: Vault | undefined; vault?: Vault }): Promise<boolean> {
    const { panelVault, vault } = opts;
    if (!currentFile && panelVault?.persistenceKind !== "remote") {
      location.href = createDocumentReloadUrl(path, panelVault?.persistenceKind === "global" ? deps.explorerFolder() : null);
      return true;
    }
    return openDocumentSafely(path, { vault });
  }

  /** T2 (onSelectVault's welcome branch, HEAD's D2/D3) — the ONLY transaction
   *  with no `read` at all, so the pre-commit stale check is trivially true
   *  (nothing async has happened yet between `beginToken()` and this call) —
   *  the exact "동치" (equivalent) relationship design §2.1's D2 row
   *  documents, not a behavior change from omitting a check HEAD never had
   *  either. `resumeOnAbort: true` matches HEAD's D5. `onCommit` (select the
   *  vault) runs, THEN `renderWelcomeForVault()`, THEN `onRendered` (jump the
   *  Explorer to the vault's root) — same order HEAD's onSelectVault welcome
   *  branch committed in, so `syncExplorerToOpenedDocument`'s branch-2 still
   *  sees the jump that already landed (HEAD's own ordering comment). */
  async function enterVaultWelcome(opts: { onCommit: () => void; onRendered?: () => void }): Promise<void> {
    const token = beginToken();
    const sourceEditor = current;
    await runTransition<never>({
      token,
      sourceEditor,
      resumeOnAbort: true,
      handoff: () => watcherHandoff.handoff(undefined),
      commit: () => {
        opts.onCommit();
        renderWelcomeForVault();
        opts.onRendered?.();
      },
    });
  }

  /** BC-3 (approved, C11) — closeActiveTab's commit-time guard. An INACTIVE
   *  tab can be closed with no lifecycle participation at all (the
   *  pre-transaction guard in main.ts's handler, design §3.2/plan C5 —
   *  `!wasActive` skips `beginLifecycleRequest` entirely), so ordinary
   *  token staleness is blind to it: the ACTIVE tab's own close can finish
   *  reading its `nextTab` and still find its token "current", even though
   *  that exact tab was independently removed while the read was pending.
   *  Re-derives what the next-active path WOULD be from the CURRENT
   *  `vaultTabs` store (after removing the tab THIS transaction is
   *  closing) and compares it to the `nextTab` this transaction actually
   *  read — a mismatch means mounting that already-read content under
   *  whatever tab is now last would write it to the WRONG path on the next
   *  autosave (the exact corruption tests/document-transactions.test.ts's
   *  C3.5 used to characterize before BC-3). Named so the rule isn't an
   *  inline `if` inside the transaction spec (intent-review). Pure query
   *  (CQS) — `undefined === undefined` (both "no next tab") counts as a
   *  match, so closing the last tab is never blocked by this guard. */
  function closeTargetStillMatchesRead(vault: Vault, tab: VaultTab, nextTab: VaultTab | undefined): boolean {
    const stillThere = vaultTabs.get(vault.vaultId).tabs.filter((candidate) => candidate.tabId !== tab.tabId);
    return stillThere[stillThere.length - 1]?.path === nextTab?.path;
  }

  /** T3 (onCloseTab's active-tab branch). The pre-transaction guard (an
   *  inactive tab, or a different vault than the one currently routed —
   *  closeable with no lifecycle participation at all) stays in main.ts's
   *  handler (design §3.2/plan C5 — `mainSource`'s own text asserts this).
   *  `currentTabs`/`remainingTabs`/`nextTab` are computed in the SAME
   *  synchronous span the token is minted in, matching HEAD's own timing
   *  (the `nextTab` a stale reader raced against is frozen at commit time,
   *  never re-read). `read` is omitted entirely when there's no `nextTab`
   *  (closing the last tab — HEAD never called `fileHostFor` in that case
   *  either). */
  async function closeActiveTab(vault: Vault, tab: VaultTab, scope: TabPersistenceScope): Promise<void> {
    const currentTabs = vaultTabs.get(vault.vaultId);
    const remainingTabs = currentTabs.tabs.filter((candidate) => candidate.tabId !== tab.tabId);
    const nextTab = remainingTabs[remainingTabs.length - 1];
    const token = beginToken();
    const sourceEditor = current;
    await runTransition<{ text: string; mtime: number }>({
      token,
      sourceEditor,
      read: nextTab ? async () => { return fileHostFor(vault).readFile(nextTab.path); } : undefined,
      onReadError: (error) => {
        deps.showOpenRecovery(nextTab.path, String(error), vault);
        return "abort-silently";
      },
      resumeOnAbort: true,
      handoff: () => watcherHandoff.handoff(nextTab?.path, vault),
      guard: () => closeTargetStillMatchesRead(vault, tab, nextTab),
      // The interference that breaks the guard never changes what's
      // MOUNTED (this transaction hasn't committed) — `currentFile` is
      // still `tab.path`, still owned by `vault`, so re-watching exactly
      // that is always the correct restoration (audit 🟡-1's narrow
      // post-handoff window).
      restoreAfterHandoff: () => watcherHandoff.handoff(currentFile, vault),
      commit: (freshValue) => {
        const fresh = freshValue as { text: string; mtime: number } | undefined;
        const nextTabs = vaultTabs.close(vault.vaultId, tab.tabId, scope);
        setRoutedVault(vault);
        const selection = selectVaultView(nextTabs);
        if (selection.kind === "document" && fresh) openInWindow(selection.tab.path, fresh, {});
        else renderWelcomeForVault();
      },
    });
  }

  // Document navigation history (⌘[/⌘]) — ephemeral in-memory session state, NOT
  // a setting: starts empty; the first openInWindow records the launch file.
  // Distinct from the recent MRU list (recentDocsSetting) — see nav-history.ts.
  // Ruling 9: each history entry remembers the vault it was opened FROM
  // (`vaultId`, resolved back to a live `Vault` via workspaceStore at
  // navigate time — never a captured `Vault` object, which could go stale
  // if the vault is later unregistered). nav-history.ts's stack arithmetic
  // is generic over the entry type and stores/returns `NavEntry` opaquely,
  // so its own pure logic (and tests) never need to know "vault" exists.
  interface NavEntry {
    readonly path: string;
    readonly vaultId: string;
  }
  let navHistory: NavHistory<NavEntry> = makeHistory();

  /** Record a document mount in the back/forward history — unless it WAS a
   *  history move (viaHistory), in which case the pointer was already set by the
   *  handler and re-pushing would break back/forward. Named so the "don't
   *  re-record a history move" rule lives in one place, not an inline if.
   *  `vaultId` (not a `Vault` object) — navigateHistory re-resolves it through
   *  workspaceStore at navigate time, so a vault unregistered after this push
   *  is a normal "unknown vault" fallback, never a stale captured object. */
  function recordNavigation(file: string, vaultId: string, viaHistory: boolean): void {
    if (viaHistory) return;
    navHistory = pushHistory(navHistory, { path: file, vaultId });
  }

  /** T4 (navigateHistory/goBack/goForward) — folded onto runTransition.
   *  **BC-1 (approved, C9)**: T4 shares the SAME lifecycle counter as
   *  T1/T2/T3 (`beginToken()`, minted right after the no-op check — a no-op
   *  move never touches the counter, matching D1's original "only a REAL
   *  navigation is a user action" intent) — the "last user action wins"
   *  property tests/document-transactions.test.ts's C4.7/C4.8/C4.10 pin.
   *  `onReadError` (prune the dead entry) is gated by the SAME
   *  `token.isCurrent()` check every other transaction's read failure uses
   *  — a STALE history read failure is silently dropped instead of
   *  pruning, consistent with T1's stale-read handling. **BC-2 (approved,
   *  C10)**: `resumeOnAbort: true` — T4 now resumes writes on abort exactly
   *  like T1/T2/T3 (C4.6). T4 is no longer special-cased anywhere in this
   *  function's `runTransition` spec; it behaves identically to T1/T3 in
   *  every stale-check/resume dimension. The pointer (`navHistory = next`)
   *  commits inside `commit`, same position HEAD's own body had it (only
   *  after read+commitBeforeSwitch+handoff all succeeded) — and BC-1 closes
   *  D11's race for free: `commit` only runs when the token is still
   *  current, so a stale mover's `next` can never overwrite a later one's
   *  pointer. */
  async function navigateHistory(move: (h: NavHistory<NavEntry>) => NavHistory<NavEntry>): Promise<void> {
    const next = move(navHistory);
    if (next === navHistory) return; // at an end → no-op (same-ref signal)
    const token = beginToken();
    const entry = currentEntry(next);
    if (!entry) return;
    const target = entry.path;
    // Ruling 9: the vault THIS history entry was opened from — resolved fresh
    // by id through workspaceStore (never a captured Vault object, which
    // could go stale if the vault was unregistered since this entry was
    // pushed) — never `currentVault()`, which is the vault of whatever is
    // open RIGHT NOW, i.e. the navigation's SOURCE, not its target. An
    // unresolvable id (vault unregistered, or a same-session edge case)
    // falls back to the old behavior.
    const targetVault = resolveTargetVault(workspaceStore.getVault(entry.vaultId), currentVault(), workspaceStore.getGlobalVault());
    await runTransition<{ text: string; mtime: number }>({
      token,
      sourceEditor: current,
      read: async () => { return fileHostFor(targetVault).readFile(target); },
      onReadError: () => {
        // The target file is gone: forget it and skip (no navigation).
        navHistory = pruneAt(navHistory, next.index);
        return "abort-silently";
      },
      resumeOnAbort: true,
      handoff: () => watcherHandoff.handoff(target, targetVault),
      commit: (freshValue) => {
        const fresh = freshValue as { text: string; mtime: number };
        navHistory = next; // commit the pointer only after the read succeeded
        openInWindow(target, fresh, { viaHistory: true }, targetVault);
      },
    });
  }
  const goBack = (): void => void navigateHistory(back);
  const goForward = (): void => void navigateHistory(forward);

  return {
    get current() { return current; },
    get currentFile() { return currentFile; },
    get currentBaseDir() { return currentBaseDir; },
    get currentIsRemote() { return currentIsRemote; },
    get currentOpenVaultId() { return currentOpenVaultId; },

    openDocument,
    openDocumentSafely,
    openFromPanel,
    enterVaultWelcome,
    closeActiveTab,
    goBack,
    goForward,

    commitBeforeSwitch,
    renderWelcomeForVault,
    saveSessionState,
    acceptsWatchEvent,

    readonlyView,
  };
}
