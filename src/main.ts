import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dirOf, resolveOpenPath } from "./path";
import { createOpenPathPrompt } from "./open-file/path-prompt";
import { createOutlinePanel } from "./outline/outline-panel";
import { createExplorerPanel, type DirEntry } from "./explorer/explorer-panel";
import { mountEditor, type EditorController, type PreviewMode, type SaveStatus } from "./editor";
import { applyTheme, applyFontScale, makeThemeToggle } from "./theme";
import {
  themeSetting,
  modeSetting,
  fontScaleSetting,
  zoomIn,
  zoomOut,
  resetZoom,
  loadPreset,
  nextPreset,
  syncJsonToPreset,
  themeJsonSetting,
  fontFamilySetting,
  webFontSetting,
  effectiveReadingFont,
  fontSizeSetting,
  readingWidthSetting,
  lineHeightSetting,
  headingRatioSetting,
  autosaveDelaySetting,
  conflictPolicySetting,
  panZoomSetting,
  themeForceSetting,
  seedSessionMode,
  vimModeSetting,
  keybindingsSetting,
  recentDocsSetting,
  sidebarWidthSetting,
} from "./settings/app";
import { themeVarsSink, cssVarSink, headingScaleSink, webFontSink } from "./settings/sinks";
import { createSidebarSash } from "./sidebar/sash";
import { createSettingsButton } from "./settings/panel/modal";
import { copyBundleToClipboard } from "./bundle";
import { registerHandler, installDispatcher, bindKeybindings } from "./shortcuts/registry";
import { arrangeStatusBar } from "./status-bar";
import { createTitleBar, arrangeTitleBar } from "./title-bar";
import { createRecentPanel } from "./recent/recent-panel";
import { pushRecent, pruneMissing } from "./recent/recent-docs";
import {
  makeHistory,
  pushHistory,
  back,
  forward,
  currentEntry,
  pruneAt,
  type NavHistory,
} from "./history/nav-history";
import { decideExternalChange, onFileChanged, watchFile, unwatchFile } from "./file-watch";
import { openConflictModal } from "./conflict/conflict-modal";
import { icon, type IconName } from "./icons";
import { refreshMermaidTheme } from "./markdown/mermaid-widget";
import "katex/dist/katex.min.css";
import "./fonts/fonts.css";
import "./styles.css";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** Set a chrome button (title-bar or footer) to a Lucide icon + (optional) label,
 *  replacing whatever it held. The shadcn/Raycast button shape: a 16px monochrome
 *  icon followed by a 13px-medium label, both inheriting the button's `color`.
 *  Replaces the old emoji `textContent =` calls — same render-on-state pattern,
 *  DOM shape only. The label rides in its own <span> so the icon stays a clean
 *  flex item (gap from CSS). */
function setButtonContent(btn: HTMLElement, name: IconName, label?: string): void {
  btn.replaceChildren(icon(name));
  if (label) {
    const text = el("span", "chrome-btn-label");
    text.textContent = label;
    btn.append(text);
  }
}

/** A save-status indicator that lives inline in the status bar. Autosave runs
 *  invisibly (200ms typing-pause debounce) so there are no manual save/reload
 *  buttons — this is just a trust signal ("저장됨"/"저장 중"). On `conflict` the
 *  external-change modal owns the actual choice; here the label only reports the
 *  state ("외부 변경 감지 — 선택 필요"). */
function makeSaveStatus(): {
  el: HTMLElement;
  set: (s: SaveStatus, detail?: string) => void;
} {
  const node = el("span", "save-status");
  const label = el("span", "save-label");
  node.append(label);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    el: node,
    set(s, detail) {
      clearTimeout(hideTimer);
      node.dataset.state = s;
      if (s === "error") {
        setButtonContent(label, "triangle-alert", `저장 실패: ${detail ?? "unknown error"}`);
      } else if (s === "conflict") {
        setButtonContent(label, "triangle-alert", "외부 변경 감지 — 선택 필요");
      } else if (s === "saving") {
        setButtonContent(label, "loader-circle", "저장 중");
      } else {
        setButtonContent(label, "check", "저장됨");
        hideTimer = setTimeout(() => label.replaceChildren(), 1500);
      }
    },
  };
}

/** Edit/read toggle that lives in the title-bar (icon + label). */
function makeModeToggle(): { btn: HTMLButtonElement; render: (m: PreviewMode) => void } {
  const btn = el("button", "chrome-btn mode-toggle");
  const render = (m: PreviewMode) => {
    setButtonContent(btn, m === "edit" ? "square-pen" : "eye", m === "edit" ? "편집" : "리더");
    btn.title = m === "edit" ? "편집 모드 (⌘E: 리더 모드로)" : "리더 모드 (⌘E: 편집 모드로)";
  };
  return { btn, render };
}

async function boot() {
  // Theme is the SSOT; bind the DOM sink first so the dataset is set before the
  // editor mounts (mermaid reads it on its lazy initial load) — and so it also
  // applies on the no-file / error screens below.
  themeSetting.bind(applyTheme);
  // The theme JSON is the effective source: fan its token map onto documentElement
  // (inline vars beat :root[data-theme]). Bind here, before the editor mounts, so
  // the vars are on the DOM for the editor + the no-file/error screens — and so a
  // saved/custom theme applies on first paint with no flash.
  themeJsonSetting.bind(themeVarsSink());
  // Preset → JSON sync: when the preset (themeSetting) changes via a path that
  // does NOT go through loadPreset (the panel's preset segmented control writes
  // themeSetting only), overwrite the JSON theme with that preset's builtin so
  // the color pickers + visual editor track the preset in real time. The name
  // guard inside syncJsonToPreset makes the loadPreset path a no-op (no double
  // write) and preserves user edits when re-selecting the same preset.
  themeSetting.subscribe(syncJsonToPreset);
  // Body text scale is the SSOT too: bind the CSS-var sink here (same place,
  // same reason as theme) so the saved scale is on the DOM before the editor
  // mounts, and so it applies on the no-file / error screens below.
  fontScaleSetting.bind(applyFontScale);
  // Typography sinks — one setting.bind(sink) line each, no hand fan-out. These
  // drive CSS vars composed in styles.css (--editor-font-size composes with
  // --font-scale; --measure caps the reading column; --line-height the leading).
  // --reading-font has a SINGLE writer: webFontSink. The web font (if any) and the
  // font-family select are composed by effectiveReadingFont into {family, stack}
  // and fed to that one sink, so the head <link> + the var never have two writers
  // racing. webFontSetting.bind does the boot-time first apply; fontFamily only
  // re-composes on change (subscribe), so they don't double-apply at boot.
  const applyReadingFont = webFontSink();
  const composeReadingFont = () =>
    applyReadingFont(effectiveReadingFont(webFontSetting.get(), fontFamilySetting.get()));
  webFontSetting.bind(composeReadingFont); // initial + on web-font change
  fontFamilySetting.subscribe(composeReadingFont); // re-compose when the select changes
  fontSizeSetting.bind(cssVarSink("--editor-font-size", (px: number) => `${px}px`));
  readingWidthSetting.bind(cssVarSink("--measure", (ch: number) => `${ch}ch`));
  lineHeightSetting.bind(cssVarSink("--line-height"));
  // Left sidebar width (drag sash): same setting.bind(cssVarSink) shape as the
  // typography vars above. The sash (below, once `workspace` exists) previews
  // the width as a transient var during drag and commits here on release; this
  // sink re-applies that same value, so SSOT and the var converge (idempotent).
  sidebarWidthSetting.bind(cssVarSink("--sidebar-width", (px: number) => `${px}px`));
  // Heading typescale: one ratio → six --hN-scale vars (headingScaleSink fans
  // them; styles.css multiplies each into its line's font-size calc).
  headingRatioSetting.bind(headingScaleSink());
  const root = document.querySelector<HTMLDivElement>("#app")!;
  const file = new URLSearchParams(location.search).get("file");
  if (!file) {
    root.textContent = "No file specified.";
    return;
  }

  // #app is a flex column: the editor scrolls inside `host`, with a title-bar
  // pinned above it (sidebar toggles, open-path, mode/theme/settings — M2) and
  // a status bar pinned below it (save state, cursor position, M3's breadcrumb
  // slot) — no more controls floating over the content. host + bar are built
  // ONCE; re-opening a file swaps only the editor inside host.
  root.innerHTML = "";
  const host = el("div", "editor-host");
  // .workspace is a flex ROW: the explorer sidebar (left) + the editor host
  // (right). The status bar stays full-width below it (VSCode-style), so
  // #app = column( titleBar, workspace(row: aside | host), bar ). host is
  // unchanged inside workspace, so every host.querySelector(".cm-scroller")
  // reference, the measure tree, and the ⌘± zoom guard are untouched — the
  // title-bar strip sits entirely outside .workspace.
  const workspace = el("div", "workspace");
  workspace.append(host);
  const bar = el("div", "status-bar");
  const titleBar = createTitleBar();
  root.append(titleBar.el, workspace, bar);

  // Boot mode = the panel's defaultMode (seed the live modeSetting from it),
  // then read it. After boot, ⌘E only moves modeSetting; defaultMode re-seeds
  // on the next launch. The two settings stay distinct (boot source vs session).
  // Seeding runs ONCE here, not on every re-open — re-opening preserves the
  // current session mode/vim (matches vim `:e`, which keeps the editor's mode).
  seedSessionMode();
  const toggleMode = () => modeSetting.set(modeSetting.get() === "edit" ? "read" : "edit");

  // Chrome (title-bar + footer) is persistent across re-mounts; its callbacks
  // read the mutable `current` (set by openInWindow), so they always reach the
  // live editor.
  const mode = makeModeToggle();
  const pos = el("span", "status-pos");
  const spacer = el("span", "status-spacer");
  const save = makeSaveStatus();
  // live theme switch: cycle the preset (nextPreset = dark→light→claude→dark, the
  // SSOT for the toggle order) via loadPreset, which writes themeJson + themeSetting
  // in one place, keeping them coherent → vars + data-theme + mermaid re-bake track
  // together, no page reload, so the layout never flashes/re-mounts.
  const themeBtn = makeThemeToggle(() => loadPreset(nextPreset(themeSetting.get())));
  themeSetting.bind(themeBtn.render); // initial icon + on change
  // Title-bar and footer are each arranged once, below, after every chrome part
  // is built — arrangeTitleBar/arrangeStatusBar own their respective left→right
  // contracts (single named ordering function each, M2 §1/§2).

  // "Currently open document" — the single source of truth for which editor /
  // file / baseDir is live. All window-global sinks and listeners read this
  // mutable cell; openInWindow re-points it. No second copy of "which file".
  let current: EditorController;
  let currentFile = file;
  let currentBaseDir = dirOf(file);
  // Document navigation history (⌘[/⌘]) — ephemeral in-memory session state, NOT
  // a setting: starts empty; the first openInWindow records the launch file.
  // Distinct from the recent MRU list (recentDocsSetting) — see nav-history.ts.
  let navHistory: NavHistory = makeHistory();
  // The per-file teardown closures the previous openInWindow installed (scroll
  // listener, pending session timer). teardownCurrent runs them before swap.
  let detachScroll: (() => void) | undefined;
  let cancelSessionTimer: (() => void) | undefined;

  // ── Open-by-path title-bar chrome (M2: moved from the footer). The button
  //    toggles the title-bar itself into a path input; onOpen resolves the typed
  //    path against the live baseDir, guards unsaved work, then re-mounts. A read
  //    failure rejects → the bar shows the error and stays in editing; the
  //    current editor is untouched. ─────────────────────────────────────────────
  const prompt = createOpenPathPrompt({
    bar: titleBar.el,
    onOpen: async (raw) => {
      const target = resolveOpenPath(raw, currentBaseDir);
      if (!target) throw new Error("경로를 입력하세요");
      // read_file first: if it fails (missing/unreadable) we throw BEFORE any
      // teardown, so the switch only happens after a successful read.
      const fresh = await invoke<{ text: string; mtime: number }>("read_file", { path: target });
      await commitBeforeSwitch();
      openInWindow(target, fresh);
    },
  });
  // ── Outline (table of contents) title-bar chrome. Same toggle shape as
  //    open-path but a vertical heading tree; clicking a heading jumps via the
  //    shared jumpTo landing. getView is a closure over `current` so it follows
  //    re-opens. Its listener is threaded into every mount (extraExtensions)
  //    so the outline tracks the live document. ────────────────────────────────
  // The left sidebar area holds one panel at a time (explorer OR outline,
  // VSCode-style). Named coordinator so the "one left sidebar at a time" rule
  // lives in one place, not an inline if at each panel. Each panel calls its
  // onOpen when it opens; this closes whichever other left sidebar was showing.
  // The closure is evaluated at click time, so referencing `explorer` (declared
  // just below) is safe. close() is idempotent, so an unconditional call is fine.
  const closeOtherSidebars = (keep: "explorer" | "outline" | "recent"): void => {
    if (keep !== "explorer") explorer.close();
    if (keep !== "outline") outline.close();
    if (keep !== "recent") recent.close();
  };
  const outline = createOutlinePanel({
    getView: () => current.view,
    onOpen: () => closeOtherSidebars("outline"),
  });

  // ── File explorer LEFT SIDEBAR. A lazy tree rooted at the live document's
  //    folder: click reads children (list_dir), `..` single-clicks/Enters
  //    upward, a markdown file click/Enter reuses main's open path (read_file →
  //    commit → mount) with zero new open code. Injected handlers keep it
  //    backend-independent and reuse commitBeforeSwitch/openInWindow.
  const explorer = createExplorerPanel({
    listDir: (p) => invoke<DirEntry[]>("list_dir", { path: p }),
    getBaseDir: () => currentBaseDir,
    onOpenFile: async (absPath) => {
      const fresh = await invoke<{ text: string; mtime: number }>("read_file", { path: absPath });
      await commitBeforeSwitch();
      openInWindow(absPath, fresh);
    },
    onOpen: () => closeOtherSidebars("explorer"),
  });

  // ── Recent documents LEFT SIDEBAR. Same toggle shape as explorer/outline; the
  //    list is read from recentDocsSetting (SSOT — the panel never writes it)
  //    and a click reuses main's open path. A read failure prunes the dead
  //    entry. The panel re-renders from a single recentDocsSetting.subscribe
  //    below. ──────────────────────────────────────────────────────────────────
  const recent = createRecentPanel({
    getRecent: () => recentDocsSetting.get(),
    onOpenFile: async (absPath) => {
      try {
        const fresh = await invoke<{ text: string; mtime: number }>("read_file", { path: absPath });
        await commitBeforeSwitch();
        openInWindow(absPath, fresh);
      } catch (err) {
        console.error("Failed to open recent document; pruning it", err);
        recentDocsSetting.set(pruneMissing(recentDocsSetting.get(), absPath));
      }
    },
    onOpen: () => closeOtherSidebars("recent"),
  });

  // Title-bar order (single contract, arrangeTitleBar owns it): 탐색기 · 최근 ·
  // 목차 · 경로열기 · [drag spacer] · 모드 · 테마 · ⚙, window-controls always last
  // (win/linux). createSettingsButton only builds the button + lazy modal
  // wiring — position is this call's job, not modal.ts's (M2 decision).
  arrangeTitleBar(titleBar.el, {
    explorer: explorer.button,
    recent: recent.button,
    outline: outline.button,
    openPath: prompt.button,
    mode: mode.btn,
    theme: themeBtn.btn,
    settings: createSettingsButton(),
  });
  // Footer order (single contract, arrangeStatusBar owns it): 브레드크럼 슬롯 ·
  // spacer · save · pos (pos far right). The breadcrumb slot is an empty
  // placeholder in M2 — its POSITION is the contract; M3 fills it with real
  // breadcrumb content.
  arrangeStatusBar(bar, {
    breadcrumb: el("span", "breadcrumb-slot"),
    spacer,
    save: save.el,
    pos,
  });
  // The explorer + outline + recent are LEFT sidebars (not footer popovers):
  // mount all three as the leading children of .workspace so they sit left of
  // the editor host. They are mutually exclusive (one visible at a time via
  // closeOtherSidebars), so their left-to-right order is never seen
  // simultaneously — prepend order among them is arbitrary.
  workspace.prepend(outline.aside);
  workspace.prepend(explorer.aside);
  workspace.prepend(recent.aside);
  // The drag sash sits between whichever left sidebar is open and the editor
  // host. DOM order: recent.aside, explorer.aside, outline.aside, sash, host. Its own
  // visibility is CSS-only (styles.css: hidden unless a sidebar sibling is
  // open) — no JS coupling to closeOtherSidebars needed.
  const sash = createSidebarSash();
  host.before(sash.el);

  // The recent panel is a sink of recentDocsSetting: re-render on every change
  // (no-op while closed). Single subscription — no hand fan-out.
  recentDocsSetting.subscribe(() => recent.refresh());

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
        localStorage.setItem(`mermark.session.${currentFile}`, JSON.stringify({ scroll, cursor }));
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
  async function commitBeforeSwitch(): Promise<void> {
    if (!current.hasUnsaved()) return;
    current.beginClose();
    await current.saveOnClose();
  }

  /** Tear down the live editor before a swap: persist its session immediately,
   *  stop its autosave (beginClose), detach its scroll listener + session timer,
   *  then drop its CM DOM. Leaves host empty for the next mount. */
  function teardownCurrent(): void {
    if (!current) return;
    saveSessionState(true);
    current.beginClose();
    detachScroll?.();
    detachScroll = undefined;
    cancelSessionTimer?.();
    cancelSessionTimer = undefined;
    // Stop watching the outgoing file: the watcher is a single slot, so a stale
    // watch would deliver file-changed events for the wrong file after a switch.
    // openInWindow re-arms the watch for the new file below.
    void unwatchFile();
    host.replaceChildren();
  }

  /** Mount `file`'s content as the live editor in `host`, re-pointing every
   *  per-file binding (doc, baseDir for images/wikilinks, autosave target +
   *  mtime baseline, session key) by going through the verified mountEditor
   *  boot path. Tears down any previous editor first. Mode/vim are preserved
   *  from the live settings (a re-open keeps your edit/read + vim state). */
  function openInWindow(
    file: string,
    fresh: { text: string; mtime: number },
    opts: { viaHistory?: boolean } = {},
  ): void {
    teardownCurrent();
    currentFile = file;
    currentBaseDir = dirOf(file);
    const { text, mtime } = fresh;

    current = mountEditor(host, text, currentBaseDir, file, {
      onStatus: save.set,
      initialMode: modeSetting.get(),
      onCursor: (line, col) => {
        pos.textContent = `Ln ${line}, Col ${col}`;
        saveSessionState();
      },
      baseMtime: mtime,
      autosaveDelay: autosaveDelaySetting.get(),
      conflictPolicy: conflictPolicySetting.get(),
      vimMode: vimModeSetting.get(),
      // Outline panel's docChanged listener — re-attaches per mount, so the
      // outline tracks whichever document is currently live.
      extraExtensions: outline.listener,
    });

    const scroller = host.querySelector(".cm-scroller");
    if (scroller) {
      const onScroll = () => saveSessionState();
      scroller.addEventListener("scroll", onScroll, { passive: true });
      detachScroll = () => scroller.removeEventListener("scroll", onScroll);
    }

    // Restore session state for this file's key.
    let savedSession: string | null = null;
    try {
      savedSession = localStorage.getItem(`mermark.session.${file}`);
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

    // Watch the newly mounted file for external changes (single slot — replaces
    // the watch teardownCurrent just released). Non-fatal: the editor works even
    // if the watcher fails to arm.
    void watchFile(file);

    // Re-opening swaps the document without firing docChanged on the new editor,
    // so an open outline panel would show the previous file's headings. Refresh
    // explicitly here (no-op when the panel is closed) so it tracks the swap.
    outline.refresh();
    // The explorer's root is the live document's folder — reseed it on a switch
    // (ephemeral root, not a setting). A no-op when the panel is closed.
    explorer.resetToBaseDir();

    // Record this document as most-recent — the SINGLE write point for the recent
    // list (dedup → front → cap via pushRecent). The recent panel re-renders from
    // its recentDocsSetting subscription; localStorage persists it across restarts.
    recentDocsSetting.set(pushRecent(recentDocsSetting.get(), file));

    // Record the navigation in the back/forward history — the SAME single locus
    // as the recent write. A back/forward move (viaHistory) must NOT re-push (the
    // handler already moved the pointer), else ⌘[ would loop. Named so the "don't
    // re-record a history move" rule isn't an inline if.
    recordNavigation(file, opts.viaHistory ?? false);

    // dev-only: expose the live controller so the debug harness can read real
    // editor state (selection offsets, block specs) instead of guessing.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
      (window as unknown as { __mermark?: unknown }).__mermark = current;
  }

  /** Record a document mount in the back/forward history — unless it WAS a
   *  history move (viaHistory), in which case the pointer was already set by the
   *  handler and re-pushing would break back/forward. Named so the "don't
   *  re-record a history move" rule lives in one place, not an inline if. */
  function recordNavigation(file: string, viaHistory: boolean): void {
    if (viaHistory) return;
    navHistory = pushHistory(navHistory, file);
  }

  /** Step the history cursor by `move` (back/forward) and open the target,
   *  reusing the single open path. A no-op move (already at an end) returns
   *  early. The pointer is only committed AFTER a successful read, so a failed
   *  read leaves the history unchanged — a dead entry is pruned and skipped.
   *  Command (void). Shared body so back and forward differ by one function. */
  async function navigateHistory(move: (h: NavHistory) => NavHistory): Promise<void> {
    const next = move(navHistory);
    if (next === navHistory) return; // at an end → no-op (same-ref signal)
    const target = currentEntry(next);
    if (!target) return;
    let fresh: { text: string; mtime: number };
    try {
      fresh = await invoke<{ text: string; mtime: number }>("read_file", { path: target });
    } catch {
      // The target file is gone: forget it and skip (no navigation).
      navHistory = pruneAt(navHistory, next.index);
      return;
    }
    await commitBeforeSwitch();
    navHistory = next; // commit the pointer only after the read succeeded
    openInWindow(target, fresh, { viaHistory: true });
  }
  const goBack = (): void => void navigateHistory(back);
  const goForward = (): void => void navigateHistory(forward);

  // ── Window-global wiring (installed ONCE; reads `current` so it always
  //    reaches the live editor after a re-mount). ─────────────────────────────

  /** Resolve an external (on-disk) change against the live buffer. The branch
   *  rule lives in decideExternalChange (pure): with no unsaved work the disk
   *  version is adopted silently (reloadFromFile); otherwise the two diverged so
   *  the conflict modal lets the user pick — keep local (forceSave = clobber +
   *  rebaseline) or use external (reloadFromFile). Named so the "auto-reload vs
   *  conflict" decision isn't an inline if at the listener site. Command: void. */
  let openConflict: { close(): void } | null = null;
  function resolveExternalChange(text: string, mtime: number): void {
    if (decideExternalChange(current.hasUnsaved()) === "reload") {
      current.reloadFromFile(text, mtime);
      return;
    }
    // Don't stack modals if a second change arrives while one is open.
    openConflict?.close();
    openConflict = openConflictModal({
      local: current.view.state.doc.toString(),
      external: text,
      onKeepLocal: () => current.forceSave(),
      onUseExternal: () => current.reloadFromFile(text, mtime),
      onDismiss: () => {
        openConflict = null;
      },
    });
  }
  // Subscribe ONCE to the backend's external-change event; the callback reads the
  // live `current` cell, so it tracks re-opens without re-subscribing. Self-writes
  // are filtered in the backend (mtime baseline), so this only fires on real
  // external edits. Guarded to Tauri/browser-mock environments that emit events.
  void onFileChanged(({ text, mtime }) => resolveExternalChange(text, mtime));
  // Don't lose the last keystrokes typed within the autosave debounce window:
  // intercept the window close, persist the live buffer, then close. Guarded so
  // it only runs under Tauri (the browser-mock dev mode has no window IPC).
  if ("__TAURI_INTERNALS__" in window) {
    const win = getCurrentWindow();
    await win.onCloseRequested(async (e) => {
      saveSessionState(true);
      if (!current.hasUnsaved()) return;
      e.preventDefault();
      current.beginClose();
      try {
        await current.saveOnClose();
      } finally {
        await win.destroy();
      }
    });
  }
  // mermaid bakes theme colors into its SVGs, so a theme change must clear its
  // cache + re-render every block. Change-only sink (no initial work needed).
  themeSetting.subscribe((t) => {
    refreshMermaidTheme(t);
    current.refresh();
  });
  // Editor-behavior sinks: the settings are the writers, the live editor is the
  // single sink for each (no hand fan-out). autosaveDelay/conflictPolicy were
  // seeded via mountEditor opts; these keep them live across re-mounts.
  autosaveDelaySetting.subscribe((ms) => current.setAutosaveDelay(ms));
  conflictPolicySetting.subscribe((p) => current.setConflictPolicy(p));
  vimModeSetting.subscribe((mode) => current.setVimMode(mode === "on"));
  // themeForce re-bake is owned by mermaid-widget (self-subscription); main
  // only triggers the redraw it alone can dispatch.
  themeForceSetting.subscribe(() => current.refresh());
  // panZoom toggle: re-render blocks so MermaidWidget (which snapshots panZoom
  // in eq) re-creates and attachPanZoom re-runs with the new value.
  panZoomSetting.subscribe(() => current.refresh());
  mode.btn.addEventListener("click", toggleMode);

  // ── Keyboard shortcuts: every app chord flows through ONE registry + global
  //    dispatcher (src/shortcuts). Handlers are injected here because they close
  //    over boot state (the live editor via `current`, the panels, the zoom
  //    commands); bindKeybindings wires the SSOT override setting; installDispatcher
  //    arms the single capture-phase listener. This replaces the old ad-hoc
  //    window keydown listeners (⌘E/⌘⇧E, ⌘±) and bundle.ts's own listener —
  //    no hardcoded keydown remains. Chords are physical-key based (e.code), so
  //    they fire under non-Latin layouts (e.g. Korean). Zoom handlers are
  //    unchanged (→ --font-scale CSS var); only their trigger moved to the registry.
  registerHandler("mode.toggle", toggleMode);
  registerHandler("explorer.toggle", () => explorer.button.click());
  registerHandler("recent.toggle", () => recent.button.click());
  registerHandler("outline.toggle", () => outline.button.click());
  registerHandler("history.back", goBack);
  registerHandler("history.forward", goForward);
  registerHandler("openPath.toggle", () => prompt.button.click());
  registerHandler("zoom.in", zoomIn);
  registerHandler("zoom.out", zoomOut);
  registerHandler("zoom.reset", resetZoom);
  registerHandler("vim.toggle", () =>
    vimModeSetting.set(vimModeSetting.get() === "on" ? "off" : "on"),
  );
  registerHandler("save.flush", () => current.flushSave());
  // ⌘⇧C: copy the LLM context bundle (this doc + 1-hop wikilinks) to the
  // clipboard. Reads the live file via `currentFile` so it tracks re-opens;
  // transient feedback rides in the `pos` cell.
  registerHandler("bundle.copy", () => {
    if (!currentFile) return;
    void copyBundleToClipboard(currentFile).then((copied) => {
      const prev = pos.textContent;
      pos.textContent = copied ? "✓ 번들 복사됨" : "⚠ 번들 복사 실패";
      setTimeout(() => {
        if (pos.textContent !== prev) pos.textContent = prev;
      }, 1200);
    });
  });
  bindKeybindings(keybindingsSetting);
  installDispatcher();
  // mode is the SSOT: the button label binds to it; the live editor reacts to
  // changes. Persistence is handled by the store.
  modeSetting.bind(mode.render); // initial label + on change
  modeSetting.subscribe((m) => current.setMode(m));

  // First load: read + mount. A read failure here means the launch file is
  // gone — show the error in place of the editor (the bar stays).
  try {
    const fresh = await invoke<{ text: string; mtime: number }>("read_file", { path: file });
    openInWindow(file, fresh);
  } catch (e) {
    host.textContent = `Failed to open: ${String(e)}`;
  }
}

boot();
