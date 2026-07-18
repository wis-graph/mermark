import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { homeDir, documentDir } from "@tauri-apps/api/path";
import { dirOf, resolveOpenPath, normalizePath, basename } from "./document/path";
import { createOpenPathPrompt } from "./document/open-file/path-prompt";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createOutlinePanel } from "./sidebar/outline/outline-panel";
import { createExplorerPanel, type DirEntry } from "./sidebar/explorer/explorer-panel";
import { mountEditor, type EditorController, type PreviewMode, type SaveStatus } from "./editor";
import { onFeaturesChanged } from "./markdown/live-preview";
import { activateExtensions } from "./extensions";
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
  headingFontSetting,
  effectiveHeadingFont,
  autosaveDelaySetting,
  conflictPolicySetting,
  panZoomSetting,
  themeForceSetting,
  seedSessionMode,
  vimModeSetting,
  keybindingsSetting,
  recentDocsSetting,
  favoriteFoldersSetting,
  sidebarWidthSetting,
  disabledViewersSetting,
  isViewerEnabled,
} from "./settings/app";
import { themeVarsSink, cssVarSink, headingScaleSink, webFontSink, headingFontSink } from "./settings/sinks";
import { createSidebarSash } from "./sidebar/sash";
import { createSettingsButton } from "./settings/panel/modal";
import { copyBundleToClipboard } from "./document/bundle";
import { registerHandler, installDispatcher, bindKeybindings, effectiveBinding } from "./shortcuts/registry";
import { displayChord } from "./shortcuts/keys";
import { arrangeStatusBar } from "./chrome/status-bar";
import { makeWidthSlider } from "./chrome/status-bar/width";
import { makeUpdateButton } from "./chrome/status-bar/update";
import { ensureCheckedOnce } from "./update/update-flow";
import { createTitleBar, arrangeTitleBar, createLeftCommandGroup } from "./chrome/title-bar";
import { registerSidebarPanel, closeOtherSidebarPanels, installSidebarPanels } from "./sidebar/registry";
import { createBreadcrumb } from "./chrome/breadcrumb";
import { createRecentPanel } from "./sidebar/recent/recent-panel";
import { pushRecent, pruneMissing } from "./sidebar/recent/recent-docs";
import { createFavoritesSection } from "./sidebar/favorites/favorites-panel";
import { createWelcomePane } from "./chrome/welcome/welcome-pane";
import { pushFavorite, removeFavorite, isFavorite, reorderFavorite } from "./sidebar/favorites/favorite-folders";
import {
  makeHistory,
  pushHistory,
  back,
  forward,
  currentEntry,
  pruneAt,
  type NavHistory,
} from "./document/history/nav-history";
import { decideExternalChange, onFileChanged, watchFile, unwatchFile } from "./document/file-watch";
import { openConflictModal } from "./document/conflict/conflict-modal";
import { openImageViewer } from "./chrome/viewer/image-viewer";
import { registerHwpViewer } from "./chrome/viewer/hwp-viewer";
import { registerViewer, viewerFor, type Viewer } from "./chrome/viewer/registry";
import { IMAGE_EXTENSIONS, extensionOf } from "./sidebar/explorer/file-icons";
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
    // Icon-only chrome (design decision: 아이콘 온리 + 심리스 크롬) visually
    // hides .chrome-btn-label (styles.css) — the accessible name still needs
    // an explicit source, so this doubles as the aria-label. `title` (set by
    // each call site) supplies the hover tooltip on top of it.
    btn.setAttribute("aria-label", label);
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
  const btn = el("button", "chrome-btn mode-toggle icon-only");
  const render = (m: PreviewMode) => {
    setButtonContent(btn, m === "edit" ? "square-pen" : "eye", m === "edit" ? "편집" : "리더");
    btn.title = m === "edit" ? "편집 모드 (⌘E: 리더 모드로)" : "리더 모드 (⌘E: 편집 모드로)";
  };
  return { btn, render };
}

async function initDefaultFavorites() {
  const current = favoriteFoldersSetting.get();
  if (current.length === 0 && localStorage.getItem("mermark.favoriteFolders") === null) {
    try {
      const home = await homeDir();
      const docs = await documentDir();
      const list: string[] = [];
      if (home) list.push(normalizePath(home));
      if (docs) list.push(normalizePath(docs));
      favoriteFoldersSetting.set(list);
    } catch (err) {
      console.error("Failed to init default favorites:", err);
    }
  }
}

async function boot() {
  void unwatchFile();
  await initDefaultFavorites();
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
  // Heading font: "" defers to the theme (removes the inline var, letting
  // claude's Georgia or --reading-font show through); a choice overrides it.
  const applyHeadingFont = headingFontSink();
  headingFontSetting.bind((v) => applyHeadingFont(effectiveHeadingFont(v)));
  const root = document.querySelector<HTMLDivElement>("#app")!;
  const file = new URLSearchParams(location.search).get("file");

  // #app is a flex column holding ONE child, .workspace, which is now a flex
  // ROW spanning the full window height: the sidebar rail (left, full-height —
  // see the strip loop below) + .main-column (right: title-bar / editor-host /
  // status-bar). This keeps the dark rail from being clipped top/bottom by a
  // full-width header/footer (the pre-rail layout's problem). host + bar are
  // built ONCE; re-opening a file swaps only the editor inside host. host is
  // unchanged inside .main-column, so every host.querySelector(".cm-scroller")
  // reference, the measure tree, and the ⌘± zoom guard are untouched.
  root.innerHTML = "";
  const host = el("div", "editor-host");
  const workspace = el("div", "workspace");
  const main = el("div", "main-column");
  const bar = el("div", "status-bar");
  const titleBar = createTitleBar();
  main.append(titleBar.el, host, bar);
  workspace.append(main);
  root.append(workspace);

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
  const widthSlider = makeWidthSlider();
  const updateBtn = makeUpdateButton();
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
  let currentFile = file ?? "";
  let currentBaseDir = file ? dirOf(file) : "";
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
      if (!file) {
        location.href = `index.html?file=${encodeURIComponent(target)}`;
        return;
      }
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
  // ── Footer breadcrumb. Declared BEFORE explorer (same TDZ-safe shape the
  //    panels' onOpen callbacks below rely on): its onJump only reaches into `explorer` at
  //    CLICK time, by which point explorer is long since assigned, so the
  //    forward reference is safe. explorer.onRootChange (wired at its own
  //    creation, below) closes the loop the other way. ────────────────────────
  const breadcrumb = createBreadcrumb({ onJump: (abs) => explorer.jumpToRoot(abs) });

  // The left sidebar area holds one panel at a time (explorer OR outline,
  // VSCode-style). R9 (_workspace/01_architecture.md): mutual exclusion is
  // now owned by the sidebar-panels registry — closeOtherSidebarPanels
  // iterates every REGISTERED panel (built-in or extension), not a fixed
  // 3-way union, so a 4th panel joins exclusion automatically. Each panel
  // calls its onOpen when it opens; the closure is evaluated at click time,
  // so referencing panel ids here is safe. close() is idempotent, so an
  // unconditional call on the rest is fine.
  const dummyState = EditorState.create({ doc: "" });
  const dummyView = { state: dummyState } as unknown as EditorView;
  const outline = createOutlinePanel({
    getView: () => current?.view ?? dummyView,
    onOpen: () => closeOtherSidebarPanels("outline"),
  });

  // ── Favorites BOTTOM SECTION (M5, hosted inside the explorer's aside — see
  //    favorites/favorites-panel.ts header). Declared BEFORE explorer so its
  //    `.el` can be handed to createExplorerPanel({ favoritesSlot }) below —
  //    the section is a pure sink of favoriteFoldersSetting (getFavorites)
  //    and only emits events; main is the single writer (toggleFavorite /
  //    onRemove). No getCurrentFolder/onAdd any more — adding a favorite is
  //    now the folder-row star's job (onToggleFavorite, wired into explorer
  //    below). ─────────────────────────────────────────────────────────────
  const favoritesSection = createFavoritesSection({
    getFavorites: () => favoriteFoldersSetting.get(),
    onJump: (abs) => explorer.jumpToRoot(abs),
    onRemove: (abs) => favoriteFoldersSetting.set(removeFavorite(favoriteFoldersSetting.get(), abs)),
    onReorder: (abs, to) => favoriteFoldersSetting.set(reorderFavorite(favoriteFoldersSetting.get(), abs, to)),
  });

  /** "Star = membership toggle" — the ONE domain rule for what a folder-row
   *  star click / Space keypress does. Named so it isn't an inline
   *  isFavorite-then-branch at each call site (star click AND Space both
   *  route through this), and so main stays the single favoriteFoldersSetting
   *  writer for the add/remove-via-star path. Command (void). */
  function toggleFavorite(abs: string): void {
    const list = favoriteFoldersSetting.get();
    favoriteFoldersSetting.set(isFavorite(list, abs) ? removeFavorite(list, abs) : pushFavorite(list, abs));
  }

  // Viewer don't-stack slot (R11, _workspace/01_r11.md §5) — shared by every
  // registered viewer (image, and now extensions like Excel), same shape as
  // `openConflict` below: only one overlay at a time, opening a second closes
  // the first rather than stacking. Stays here, not in the registry — the
  // registry is a pure catalog (design §5: a stateful slot inside it would
  // repeat the God-object shape R9 explicitly avoided).
  let openViewer: { close(): void } | null = null;

  // The built-in image viewer registers through the SAME `registerViewer`
  // path an extension uses (R11 design §3 — dogfooding, like R9's built-in
  // sidebar panels going through registerSidebarPanel). IMAGE_EXTENSIONS
  // still owns the icon-family derivation (file-icons.ts); this is now its
  // ONLY other consumer (open-gating moved to the registry). Must run before
  // createExplorerPanel below, so the explorer's first render already sees it
  // (design §4's registration-order guarantee).
  registerViewer({ id: "image", extensions: [...IMAGE_EXTENSIONS], label: "이미지", open: openImageViewer });
  // The built-in HWP/HWPX viewer (_workspace/01_hwp_viewer.md §5) — built-in
  // rather than an extension because it needs 3 new Tauri commands, and R11's
  // extension contract is "frontend only, zero new IPC" (design §5).
  registerHwpViewer();

  /** "Which registered viewer, if any, opens this filename?" — the single
   *  rule canOpenWithViewer/openWithViewer both derive from, so they can
   *  never disagree about what's openable. Includes the enabled filter: a
   *  viewer the user disabled in the settings panel (disabledViewersSetting)
   *  is treated exactly like an unclaimed extension here, so it falls
   *  through to the existing open_path/OS-default path with no new fallback
   *  branch (viewer-toggle design §2). `.get()` at decision time — no sink,
   *  same pattern recursiveImageSearchSetting uses — so a toggle flipped in
   *  the panel takes effect on the very next open. Pure query. */
  function viewerForEntry(name: string): Viewer | null {
    const v = viewerFor(extensionOf(name));
    return v !== null && isViewerEnabled(disabledViewersSetting.get(), v.id) ? v : null;
  }

  /** Open `absPath` in its registered viewer, closing whatever the don't-stack
   *  slot currently holds first. The single owner of that rule — every viewer
   *  open (built-in image, any extension) funnels through here. No-op if no
   *  viewer claims the file (defensive; canOpenWithViewer should already have
   *  gated the caller). Command (void). */
  function openWithViewer(absPath: string): void {
    const v = viewerForEntry(basename(absPath));
    if (!v) return;
    openViewer?.close();
    openViewer = v.open(absPath);
  }

  /** "Opening a document closes any open viewer" (full-pane rewrite,
   *  _workspace/01_architect_design.md §A rule 1) — a body-level modal was
   *  harmless to leave open under a newly-opened document (it floated on
   *  top, dismissible independently), but a full-PANE viewer now occupies
   *  `.editor-host`'s own spot: opening a document without closing the
   *  viewer first would mount the new document behind a still-visible pane.
   *  `openInWindow` calls this as its very first statement, so every
   *  document-open path (explorer/recent/history/prompt — all funnel through
   *  `openInWindow`) gets the rule for free from one call site. This is the
   *  SECOND (and last) place `openViewer` is written — `openWithViewer`
   *  above is the first — main.ts's own don't-stack slot stays confined to
   *  exactly these two functions (code-auditor focus per plan's handoff).
   *  Command (void). */
  function closeOpenViewer(): void {
    openViewer?.close();
    openViewer = null;
  }

  // ── File explorer LEFT SIDEBAR. A lazy tree rooted at the live document's
  //    folder: click reads children (list_dir), `..` single-clicks/Enters
  //    upward, a markdown file click/Enter reuses main's open path (read_file →
  //    commit → mount) with zero new open code. Injected handlers keep it
  //    backend-independent and reuse commitBeforeSwitch/openInWindow.
  //    M5: also hosts the favorites section below its tree (favoritesSlot) and
  //    renders/toggles each folder row's favorite star (isFavorite/
  //    onToggleFavorite) — explorer never imports the favorites domain itself,
  //    it only receives a DOM node + two closures (same injection shape as
  //    listDir/onOpenFile). canOpenWithViewer/onOpenWithViewer (R11) open a
  //    registered viewer (image, or any extension) — unlike onOpenFile it
  //    never branches on `!file`: the viewer is a body-level overlay, not a
  //    document swap, so it works the same whether or not a markdown document
  //    is open (welcome screen included). Explorer itself never imports the
  //    viewer registry (design §4 — dependency direction stays main.ts-only).
  //    onOpenFileNewWindow (⌘/Ctrl+click, ⌘+Enter) reuses open_path — the same
  //    IPC command wikilink clicks already use to spawn a new document window.
  const explorer = createExplorerPanel({
    listDir: (p) => invoke<DirEntry[]>("list_dir", { path: p }),
    getBaseDir: () => currentBaseDir,
    onOpenFile: async (absPath) => {
      if (!file) {
        location.href = `index.html?file=${encodeURIComponent(absPath)}`;
      } else {
        const fresh = await invoke<{ text: string; mtime: number }>("read_file", { path: absPath });
        await commitBeforeSwitch();
        openInWindow(absPath, fresh);
      }
    },
    canOpenWithViewer: (name) => viewerForEntry(name) != null,
    onOpenWithViewer: openWithViewer,
    // ⌘/Ctrl+click or ⌘+Enter on a markdown row: open it in a brand-new window.
    // Reuses open_path — the same command wikilink clicks already invoke to
    // spawn a new document window — so no new backend command is needed.
    onOpenFileNewWindow: (absPath) => {
      invoke("open_path", { path: absPath }).catch((err) => {
        console.error("Failed to open in a new window", err);
      });
    },
    onOpen: () => closeOtherSidebarPanels("explorer"),
    onRootChange: (root) => breadcrumb.render(root),
    isFavorite: (p) => isFavorite(favoriteFoldersSetting.get(), p),
    onToggleFavorite: toggleFavorite,
    favoritesSlot: favoritesSection.el,
    focusFavorites: favoritesSection.focusFirst,
  });

  // ── Recent documents LEFT SIDEBAR. Same toggle shape as explorer/outline; the
  //    list is read from recentDocsSetting (SSOT — the panel never writes it)
  //    and a click reuses main's open path. A read failure prunes the dead
  //    entry. The panel re-renders from a single recentDocsSetting.subscribe
  //    below. ──────────────────────────────────────────────────────────────────
  const recent = createRecentPanel({
    getRecent: () => recentDocsSetting.get(),
    onOpenFile: async (absPath) => {
      if (!file) {
        location.href = `index.html?file=${encodeURIComponent(absPath)}`;
      } else {
        try {
          const fresh = await invoke<{ text: string; mtime: number }>("read_file", { path: absPath });
          await commitBeforeSwitch();
          openInWindow(absPath, fresh);
        } catch (err) {
          console.error("Failed to open recent document; pruning it", err);
          recentDocsSetting.set(pruneMissing(recentDocsSetting.get(), absPath));
        }
      }
    },
    onOpen: () => closeOtherSidebarPanels("recent"),
  });

  // Title-bar order (single contract, arrangeTitleBar owns it): leftGroup
  // (탐색기 · 최근 · 목차 · 경로열기) · [drag spacer] · 모드 · 테마 · ⚙,
  // window-controls always last (win/linux). M5: 즐겨찾기 button REMOVED (see
  // title-bar.ts) — the ⌘⇧B action now reveals the explorer's hosted
  // favorites section instead (registerHandler("favorites.toggle", ...)
  // below). createSettingsButton only builds the button + lazy modal wiring —
  // position is this call's job, not modal.ts's (M2 decision). R9: leftGroup
  // now starts with only openPath — registerSidebarPanel below inserts the
  // three panel toggle buttons before it, in registration order, so the
  // "탐색기·최근·목차 first, then open-path" contract is still upheld even
  // though the group is no longer built with all four in one call.
  const leftGroup = createLeftCommandGroup({ openPath: prompt.button });
  arrangeTitleBar(titleBar.el, {
    leftGroup,
    mode: mode.btn,
    theme: themeBtn.btn,
    settings: createSettingsButton(),
  });
  // Footer order (single contract, arrangeStatusBar owns it): 브레드크럼 ·
  // spacer · update · width · save · pos (pos far right). M3: the placeholder
  // span is now the real breadcrumb chrome — its content tracks the
  // explorer's live root via onRootChange (above) + the openInWindow seed
  // (below). update leads the right cluster (hidden unless update-flow found
  // a version — see chrome/status-bar/update.ts), followed by width.
  arrangeStatusBar(bar, {
    breadcrumb: breadcrumb.el,
    spacer,
    update: updateBtn.el,
    width: widthSlider.el,
    save: save.el,
    pos,
  });
  // The explorer + recent + outline are LEFT sidebars (not footer popovers).
  // R9 (_workspace/01_architecture.md): registerSidebarPanel replaces the old
  // 5 hardcoded call sites (mutual exclusion / DOM mount / top-strip / rehome
  // observer / button collection) — registration order IS button order
  // (탐색기 · 최근 · 목차, pixel-identical to the old fixed shape), and
  // installSidebarPanels seats every registered panel into the shell + arms
  // the rehoming observer in one call. They stay mutually exclusive (one
  // visible at a time via closeOtherSidebarPanels, now N-way — a 4th
  // registered panel joins automatically, the bug R9 exists to fix). aside
  // DOM order among them is still arbitrary (mutual exclusion means it's
  // never seen simultaneously), same as before R9.
  registerSidebarPanel({ id: "explorer", button: explorer.button, aside: explorer.aside, close: explorer.close });
  registerSidebarPanel({ id: "recent", button: recent.button, aside: recent.aside, close: recent.close });
  registerSidebarPanel({ id: "outline", button: outline.button, aside: outline.aside, close: outline.close });
  installSidebarPanels({ workspace, bar: titleBar.el, group: leftGroup, buttonAnchor: prompt.button });
  // The drag sash sits between whichever left sidebar is open and .main-column.
  // DOM order among the asides is arbitrary (installSidebarPanels prepends
  // each in registration order — see its comment above); the sash is
  // inserted right before .main-column, so it always ends up after every
  // aside regardless of their relative order. Its own visibility is CSS-only
  // (styles.css: hidden unless a sidebar sibling is open) — no JS coupling
  // to closeOtherSidebarPanels needed.
  const sash = createSidebarSash();
  main.before(sash.el);

  // The recent panel is a sink of recentDocsSetting: re-render on every change
  // (no-op while closed). Single subscription — no hand fan-out.
  recentDocsSetting.subscribe(() => recent.refresh());
  // Favorites now has TWO views of the same setting (M5 split-pane: the
  // section list AND every folder row's star) — still ONE subscription
  // point, which fans out to both refreshes. That's the SSOT contract: a
  // single observation point driving multiple sinks is not hand fan-out,
  // it's what "single writer, single sink" looks like with two consumers.
  favoriteFoldersSetting.subscribe(() => {
    favoritesSection.refresh();
    explorer.refreshFavoriteStars();
  });
  // A viewer toggle (settings panel) changes what `canOpenWithViewer` answers
  // for already-rendered rows, but explorer bakes `.is-nonmd` in at render
  // time and never re-asks on click (explorer-panel.ts's activateItem short-
  // circuits on the cached class) — so without this, disabling a viewer
  // mid-session left its already-rendered rows still "openable" and a click
  // fell through to onOpenFile, opening a non-markdown file AS markdown.
  // subscribe (not bind): the initial renderTree already saw the setting's
  // boot value, so a bind here would just re-run the same refresh redundantly
  // on every mount. Explorer owns no state here — this is a pure DOM sink,
  // same shape as the favoriteFoldersSetting subscription just above.
  disabledViewersSetting.subscribe(() => explorer.refreshOpenability());

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
    if (!current) return;
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
    closeOpenViewer(); // opening a document closes any open viewer (design §A rule 1)
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
    // Seed the footer breadcrumb for THIS switch too: resetToBaseDir is a no-op
    // while the explorer panel is closed (so onRootChange won't fire), and the
    // breadcrumb must still track the live document's folder even with the
    // panel shut. Idempotent with onRootChange when the panel IS open (both
    // land on the same currentBaseDir — a harmless double render).
    breadcrumb.render(currentBaseDir);

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
    if (!current) return;
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
      if (!current) return;
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
    current?.refresh();
  });
  // mermaid's themeVariables are now derived from themeJsonSetting (SSOT), so a
  // JSON-only change (e.g. a swatch edit) must also re-bake mermaid even when
  // themeSetting itself doesn't change. loadPreset() writes both settings, so a
  // preset switch double-fires this + the themeSetting subscription above —
  // refreshMermaidTheme is idempotent (cache clear + version bump), so the only
  // cost is one redundant redraw pass, accepted rather than adding de-dupe.
  themeJsonSetting.subscribe(() => {
    refreshMermaidTheme(themeSetting.get());
    current?.refresh();
  });
  // Editor-behavior sinks: the settings are the writers, the live editor is the
  // single sink for each (no hand fan-out). autosaveDelay/conflictPolicy were
  // seeded via mountEditor opts; these keep them live across re-mounts.
  autosaveDelaySetting.subscribe((ms) => current?.setAutosaveDelay(ms));
  conflictPolicySetting.subscribe((p) => current?.setConflictPolicy(p));
  vimModeSetting.subscribe((mode) => current?.setVimMode(mode === "on"));
  // Feature registry SSOT sink: a late registerInlineFeature/registerBlockFeature
  // call (an extension that finishes async init after boot, or a test) reaches
  // the currently-open editor through the ONE subscription below — no hand
  // fan-out to wherever registration might happen. Mirrors the
  // themeSetting.subscribe(() => current?.refresh()) shape above.
  onFeaturesChanged(() => current?.reloadFeatures());
  // themeForce re-bake is owned by mermaid-widget (self-subscription); main
  // only triggers the redraw it alone can dispatch.
  themeForceSetting.subscribe(() => current?.refresh());
  // panZoom toggle: re-render blocks so MermaidWidget (which snapshots panZoom
  // in eq) re-creates and attachPanZoom re-runs with the new value.
  panZoomSetting.subscribe(() => current?.refresh());
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
  // M5: ⌘⇧B no longer toggles a title-bar button (removed) — it reveals the
  // explorer's hosted favorites section (open the explorer if closed, scroll
  // + focus the section). The action id/binding are legacy-frozen (storage
  // key); only the handler's behavior changed, which is why the name here is
  // `revealFavorites`, not `toggle`.
  registerHandler("favorites.toggle", () => explorer.revealFavorites());
  registerHandler("history.back", goBack);
  registerHandler("history.forward", goForward);
  registerHandler("openPath.toggle", () => prompt.button.click());
  registerHandler("zoom.in", zoomIn);
  registerHandler("zoom.out", zoomOut);
  registerHandler("zoom.reset", resetZoom);
  registerHandler("vim.toggle", () =>
    vimModeSetting.set(vimModeSetting.get() === "on" ? "off" : "on"),
  );
  registerHandler("save.flush", () => current?.flushSave());
  // Transient status-bar feedback shared by clipboard-copy handlers: shows
  // `msg` in the `pos` cell, then restores whatever was there before the
  // *first* flash of the current burst. Command, void — no return value,
  // callers don't need one.
  //
  // Overlapping calls (e.g. ⌥⌘C then ⌘⇧C within 1200ms) must not lose the
  // real baseline: the second call would otherwise capture the first flash's
  // message as `prev`, and the first call's un-cancelled timer would still
  // fire and stomp the second flash. So a flash burst captures its baseline
  // only once (when no timer is pending) and every overlapping call cancels
  // the previous timer before scheduling its own restore.
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let flashBaseline: string | null = null;
  const flashStatus = (msg: string): void => {
    if (flashTimer === undefined) flashBaseline = pos.textContent;
    else clearTimeout(flashTimer);
    pos.textContent = msg;
    flashTimer = setTimeout(() => {
      pos.textContent = flashBaseline;
      flashTimer = undefined;
      flashBaseline = null;
    }, 1200);
  };
  // ⌘⇧C: copy the LLM context bundle (this doc + 1-hop wikilinks) to the
  // clipboard. Reads the live file via `currentFile` so it tracks re-opens;
  // transient feedback rides in the `pos` cell.
  registerHandler("bundle.copy", () => {
    if (!currentFile) return;
    void copyBundleToClipboard(currentFile).then((copied) => {
      flashStatus(copied ? "✓ 번들 복사됨" : "⚠ 번들 복사 실패");
    });
  });
  // ⌥⌘C: copy the current document's absolute path to the clipboard. No IPC —
  // `currentFile` is already the live-file SSOT cell (same one bundle.copy
  // reads), and the webview's navigator.clipboard is the same write path
  // bundle.ts uses. Graceful no-op when no document is open.
  registerHandler("path.copy", () => {
    if (!currentFile) return;
    navigator.clipboard
      .writeText(currentFile)
      .then(() => flashStatus("✓ 경로 복사됨"))
      .catch(() => flashStatus("⚠ 경로 복사 실패"));
  });
  bindKeybindings(keybindingsSetting);
  installDispatcher();
  // Personal extensions register here — after the built-in registerHandler
  // block above, before the first openInWindow below, so any boot-time
  // registration lands in that very first mount's snapshot (no reloadFeatures
  // round-trip needed for extensions that register synchronously at boot;
  // that path exists for late/async registrations instead). Cold-load cost
  // is one call to a currently-empty function (design §2.2/§3.6).
  activateExtensions();
  // mode is the SSOT: the button label binds to it; the live editor reacts to
  // changes. Persistence is handled by the store.
  modeSetting.bind(mode.render); // initial label + on change
  modeSetting.subscribe((m) => current?.setMode(m));
  // Boot-time auto-check for updates (design C-5): deferred via setTimeout so
  // it costs nothing on cold load / first paint, and placed BEFORE the
  // welcome/editor branch below so it fires whichever screen boot() ends up
  // showing. ensureCheckedOnce is idempotent and boot() itself only runs once
  // per webview load, so this can never double-check. Failures (offline, etc)
  // are swallowed inside update-flow — nothing to catch here.
  setTimeout(() => {
    void ensureCheckedOnce();
  }, 2000);

  if (!file) {
    host.classList.add("welcome-host");
    host.append(
      createWelcomePane({
        getFavorites: () => favoriteFoldersSetting.get(),
        getRecent: () => recentDocsSetting.get(),
        onJumpFolder: (folder) => explorer.jumpToRoot(folder),
        onOpenFile: (doc) => {
          location.href = `index.html?file=${encodeURIComponent(doc)}`;
        },
        // Reuses the existing explorer-toggle flow — no native folder picker,
        // no new Tauri command (IPC-surface constraint, design decision ③).
        onOpenFolder: () => explorer.button.click(),
        openFolderChord: (() => {
          const bound = effectiveBinding("explorer.toggle");
          return bound ? displayChord(bound) : null;
        })(),
      }),
    );
    return;
  }

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
