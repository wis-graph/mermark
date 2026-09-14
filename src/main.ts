import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { dirOf, resolveOpenPath, normalizePath, basename, isResolvedAbsolutePath } from "./document/path";
import { createOpenPathPrompt } from "./document/open-file/path-prompt";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createOutlinePanel } from "./sidebar/outline/outline-panel";
import { createExplorerPanel } from "./sidebar/explorer/explorer-panel";
import { localFileHost, fileHostFor, classifyRemoteError } from "./document/file-host";
import { badgeFor } from "./workspace/add-remote-vault";
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
  sidebarWidthSetting,
  disabledViewersSetting,
  isViewerEnabled,
  showHiddenFilesSetting,
} from "./settings/app";
import { themeVarsSink, cssVarSink, headingScaleSink, webFontSink, headingFontSink } from "./settings/sinks";
import { createSidebarSash } from "./sidebar/sash";
import { createSettingsButton } from "./settings/panel/modal";
import { shareableVaultsFrom } from "./settings/remote-share-panel";
import { copyBundleToClipboard } from "./document/bundle";
import { copyTextToClipboard } from "./clipboard";
import { registerHandler, installDispatcher, bindKeybindings, effectiveBinding } from "./shortcuts/registry";
import { displayChord } from "./shortcuts/keys";
import { arrangeStatusBar } from "./chrome/status-bar";
import { makeWidthSlider } from "./chrome/status-bar/width";
import { makeUpdateButton } from "./chrome/status-bar/update";
import { ensureCheckedOnce, subscribeUpdate, updatePhase, installAndRelaunch } from "./update/update-flow";
import {
  createTitleBar,
  arrangeTitleBar,
  createLeftCommandGroup,
  createTitleSlot,
  createViewerSlot,
} from "./chrome/title-bar";
import { registerSidebarPanel, closeOtherSidebarPanels, installSidebarPanels } from "./sidebar/registry";
import { createBreadcrumb } from "./chrome/breadcrumb";
import { createRecentPanel } from "./sidebar/recent/recent-panel";
import { createSearchPanel } from "./sidebar/search/search-panel";
import { openFindPanel, enterEditModeForReplace } from "./markdown/find";
import { pushRecent, type RecentEntry } from "./sidebar/recent/recent-docs";
import { readLegacyRecentDocPaths, migrateLegacyRecentPaths } from "./sidebar/recent/recent-vault-migration";
import { createWelcomePane } from "./chrome/welcome/welcome-pane";
import {
  makeHistory,
  pushHistory,
  back,
  forward,
  currentEntry,
  pruneAt,
  type NavHistory,
} from "./document/history/nav-history";
import { createWatcherHandoff, decideExternalChange, onFileChanged, onFileUnavailable, watchFile, unwatchFile } from "./document/file-watch";
import { openConflictModal } from "./document/conflict/conflict-modal";
import { createConflictRecovery, sameConflictIdentity, type ConflictIdentity } from "./document/conflict/conflict-recovery";
import { openRecoveryModal, type RecoveryModalHandle } from "./document/recovery-modal";
import { createRecoveryState, type RecoveryActionId, type RecoveryActionOutcome, type RecoveryKind } from "./document/recovery-contract";
import { openImageViewer } from "./chrome/viewer/image-viewer";
import { isRemoteSrc } from "./markdown/image";
import { setImageOpenHandler } from "./markdown/image-open";
import { setDocumentOpenHandler } from "./markdown/document-open";
import { openStandardLocalLink, markLocalLinkFailure, REMOTE_VAULT_LOCAL_LINK_MESSAGE } from "./markdown/local-doc-link";
import { isRemoteVault } from "./document/document-vault";
import { remoteCanOpen, remoteUnsupportedMessage } from "./document/remote-capability";
import { setImageSearchRoot, owningVaultRoot } from "./markdown/image-search-root";
import { attachImageToVault } from "./markdown/attach-image";
import {
  GLOBAL_VAULT_ID,
  REMOTE_VAULT_WIRE_ROOT,
  WorkspaceStateError,
  WorkspaceStore,
  type Vault,
  type PersistenceKind,
  type WorkspaceState,
} from "./workspace/workspace-state";
import { routeCliFile, routeCliFileResolved } from "./workspace/cli-routing";
import { createDocumentReloadUrl, readDocumentReloadHandoff } from "./workspace/reload-handoff";
import {
  favoriteFoldersStorageKey,
  favoriteVaultMigrationKey,
  canonicalizeLegacyFavoriteFolder,
  migrateFavoriteFoldersToVaults,
  readLegacyFavoriteFolders,
  shouldMigrateLegacyFavorites,
} from "./workspace/favorite-vault-migration";
import { createWorkspaceSidebar } from "./workspace/workspace-sidebar";
import { selectVaultView, VaultTabStore, type TabPersistenceScope } from "./workspace/vault-tabs";
import { openMermaidLightbox } from "./chrome/viewer/mermaid-lightbox";
import { registerHwpViewer } from "./chrome/viewer/hwp-viewer";
import { registerSqliteViewer } from "./chrome/viewer/sqlite-viewer";
import { registerEpubViewer } from "./chrome/viewer/epub-viewer";
import { registerViewer, viewerFor, type Viewer } from "./chrome/viewer/registry";
import { createDontStackSlot } from "./chrome/viewer/dont-stack-slot";
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

const SAFE_EXPLORER_BASE_PATH = "/";

/** A just-opened document's own base directory — `dirOf(file)`, with a
 *  fallback for the "file sits at its vault's own root, no directory part"
 *  case. The fallback is NOT one constant: a local vault's root is the real
 *  filesystem root (`SAFE_EXPLORER_BASE_PATH`, "/"), but a remote vault's
 *  root is the wire root (`REMOTE_VAULT_WIRE_ROOT`, "") — this baseDir feeds
 *  straight into `resolveImageSrc`/`remote_resolve_image`'s `baseDir`
 *  argument (markdown/image.ts), which for a remote document becomes a
 *  `remote_read_image` path query. Final review C1's second symptom: using
 *  the local fallback ("/") for a remote root-level document made every
 *  `![[img]]` in it resolve to "/img.png" — a path the host's `safe_path`
 *  always 404s (only "" is its own root; any leading "/" hits
 *  `resolve_within`'s `RootDir` rejection) — so every image in a root-level
 *  remote note broke. Named so the ONE fallback rule that must track
 *  `REMOTE_VAULT_WIRE_ROOT` lives in one place instead of being reinlined at
 *  each of `currentBaseDir`'s two assignment sites. */
function baseDirForOpenedDocument(file: string, vault: Vault | undefined): string {
  return dirOf(file) || (isRemoteVault(vault) ? REMOTE_VAULT_WIRE_ROOT : SAFE_EXPLORER_BASE_PATH);
}

export function shouldPreserveGlobalExplorerRoot(vault: Pick<Vault, "persistenceKind"> | undefined): boolean {
  return vault?.persistenceKind === "global";
}

/** Unreachable-branch guard for `Vault.persistenceKind` switches below. Widening
 *  `Vault` (RemoteVault's addition) only made `tsc` flag ONE hand-rolled
 *  ternary in this file (`explorerRootForVault`) — every other kind check was
 *  `=== "permanent"` / `=== "global"`, so a vault kind neither of those
 *  silently fell into an `else` written for local vaults. Routing every kind
 *  check below through a `switch (...) { default: return assertNever(x) }`
 *  makes the NEXT new vault kind fail `tsc` at every one of these sites, not
 *  just one (task-2b brief). */
function assertNever(x: never): never {
  throw new Error(`처리되지 않은 볼트 종류: ${JSON.stringify(x)}`);
}

/** Whether the Explorer must refuse to navigate above a vault's own root.
 *  Permanent vaults are locked to their registered filesystem folder; remote
 *  vaults are locked too, for a different reason — the host only serves paths
 *  inside the shared vault root, so there is no "above" to browse to even in
 *  principle. The Global Vault is the only unlocked kind (it deliberately
 *  roams the whole filesystem from HOME). `undefined` (no vault selected yet)
 *  defaults to unlocked, matching the pre-existing `currentVault()?.persistenceKind
 *  === "permanent"` check this replaces. */
export function isVaultRootLocked(vault: Pick<Vault, "persistenceKind"> | undefined): boolean {
  if (!vault) return false;
  const kind = vault.persistenceKind;
  switch (kind) {
    case "permanent": return true;
    case "global": return false;
    case "remote": return true;
    default: return assertNever(kind);
  }
}

/** Which persistence tier a vault's open-tab list belongs to. Permanent
 *  vaults restore tabs from localStorage across app restarts; every other
 *  kind is session-only. Remote vaults are deliberately session-scoped, not
 *  promoted to "permanent" alongside local vaults: persisting a tab list
 *  across restarts risks reopening a document the host no longer shares (the
 *  Mac mini offline, or the shared vault renamed/withdrawn on its side)
 *  before the host connection is even re-established — re-deriving remote
 *  tabs fresh each session is the safe default until v1's read-only scope
 *  grows a sync story. This was already the ACCIDENTAL behavior of every
 *  `=== "permanent" ? "permanent" : "session"` ternary this replaces (remote
 *  fell into the `else`); this function just makes that choice explicit and
 *  exhaustive so it survives the next vault kind. */
export function tabScopeForVault(vault: Pick<Vault, "persistenceKind">): TabPersistenceScope {
  const kind = vault.persistenceKind;
  switch (kind) {
    case "permanent": return "permanent";
    case "global": return "session";
    case "remote": return "session";
    default: return assertNever(kind);
  }
}

/** task-8a (Ruling 9): whether `routeDocumentPath` should TRUST the
 *  already-routed vault instead of re-deriving one from the document's path
 *  via `routeCliFile`. `routeCliFile` can only ever resolve "permanent" (by
 *  matching a REGISTERED PERMANENT ROOT — an absolute local path) or
 *  "global" — a remote document's path is vault-relative (`"노트.md"`, no
 *  root prefix at all) and can never match, so re-deriving would silently
 *  reclassify an already-known remote document as the Global Vault. "global"
 *  needed the same trust already (its own path re-derivation was always a
 *  no-op at best, at worst a spurious match against an unrelated registered
 *  permanent root on the same filesystem) — this just makes remote share
 *  that exact rule instead of falling through routeCliFile like "permanent"
 *  correctly still does (a real absolute path that might belong to a
 *  DIFFERENT permanent vault than the one currently routed). Pure query. */
export function routingTrustsCurrentVault(kind: PersistenceKind | undefined): boolean {
  return kind === "global" || kind === "remote";
}

/** task-8a (Ruling 9): which vault a read should route through when a caller
 *  may already know the TARGET explicitly — `openDocument`'s `targetVault`
 *  (onSelectVault/onSelectTab already know which vault they're switching
 *  TO), or `navigateHistory`'s history-entry vault (resolved fresh by id,
 *  never a captured `Vault` object). `explicit` always wins over `fallback`
 *  (typically `currentVault()` — the vault of whatever is open RIGHT NOW,
 *  i.e. the navigation's SOURCE, not its target), which itself falls back to
 *  `global`. Pure query — the entire fix for "a vault-crossing open reads
 *  through the wrong backend" collapses to this one three-way `??`, so it is
 *  tested directly instead of only through main.ts's wiring. */
export function resolveTargetVault(explicit: Vault | undefined, fallback: Vault | undefined, global: Vault): Vault {
  return explicit ?? fallback ?? global;
}

/** task-8a (Ruling 10/item 4): the Korean rejection message a standard
 *  `[text](sibling.md)` link click should show for `vault` BEFORE
 *  `resolveLocalDocumentLink` (local-doc-link.ts) ever runs, or `null` when
 *  the ordinary validation pipeline should decide instead. Every step of
 *  that pipeline past its pure prefix is `canonicalize_path` — a
 *  LOCAL-filesystem-only command with no remote equivalent and no
 *  `vaultRootPath` for a remote vault to canonicalize against — see
 *  local-doc-link.ts's header comment on `REMOTE_VAULT_LOCAL_LINK_MESSAGE`
 *  for the full item-4 reasoning. Pure query. */
export function standardLinkRejectionFor(vault: Vault | undefined): string | null {
  return isRemoteVault(vault) ? REMOTE_VAULT_LOCAL_LINK_MESSAGE : null;
}

/** The user's home directory, resolved through the EXISTING `canonicalize_path`
 *  IPC command (already used by CLI routing above) fed the literal `~` — the
 *  backend's `expand_home` (src-tauri/src/commands.rs) already special-cases
 *  a bare `~` as `$HOME`/`%USERPROFILE%`, so this needs no new backend surface.
 *  Falls back to `fallback` (the historic default root) when canonicalization
 *  fails outright (e.g. a headless test/CI environment) — the same defensive
 *  posture `routeCliFileResolved`'s own canonicalize wrapper uses just above —
 *  AND when it "succeeds" with a value that isn't actually a usable root
 *  (`isResolvedAbsolutePath`). That second guard matters because the backend's
 *  home lookup can itself fail (an environment with no resolvable home
 *  directory): `expand_home`'s documented contract on that failure is to
 *  return the input LITERALLY, so `canonicalize_path("~")` can come back as
 *  the bare relative string `"~"` (or wherever a relative `~` canonicalizes
 *  against the process's cwd) instead of raising an error. Using that as the
 *  explorer's root pointed it at an arbitrary, usually-nonexistent location —
 *  this guard keeps a home-resolution failure from ever promoting a
 *  non-absolute value to "the root". Named + exported so "how do we get home"
 *  lives in one place and is independently testable, instead of being
 *  inlined at the one call site that needs it (00_request.md #2). */
export async function resolveHomeRoot(canonicalize: (path: string) => Promise<string>, fallback: string): Promise<string> {
  try {
    const resolved = await canonicalize("~");
    return resolved && isResolvedAbsolutePath(resolved) ? resolved : fallback;
  } catch (error) {
    if (error instanceof Error || typeof error === "string") return fallback;
    throw error;
  }
}

/** Every registered PERMANENT vault's canonical root path — the exact input
 *  `owningVaultRoot` (image-search-root.ts) needs. Named so "which vaults
 *  count" (permanent only; the global vault has no `rootPath` to search)
 *  lives in one place instead of being re-derived as an inline filter at
 *  each call site. Pure query. */
export function permanentRootsOf(state: WorkspaceState): readonly string[] {
  return state.vaults.filter((vault) => vault.persistenceKind === "permanent").map((vault) => vault.rootPath);
}

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
      } else if (s === "recovery") {
        setButtonContent(label, "triangle-alert", `복구 필요${detail ? `: ${detail}` : ""}`);
      } else if (s === "saving") {
        setButtonContent(label, "loader-circle", "저장 중");
      } else {
        setButtonContent(label, "check", "저장됨");
        hideTimer = setTimeout(() => label.replaceChildren(), 1500);
      }
    },
  };
}

/** Edit/read toggle that lives in the title-bar (icon + label). Also carries
 *  the PERSISTENT remote-read-only indicator (Task 11): a remote document is
 *  forced to read mode end to end (editor.ts's `remoteReadOnly`), but before
 *  this the toggle only ever reflected the global `modeSetting` — so it could
 *  still show "편집" while the open document was, in fact, uneditable, and the
 *  user only learned the truth from a transient error toast on the next
 *  keystroke/save attempt. `remote: true` replaces the edit/read label
 *  outright with a fixed "읽기 전용 (원격)" state, for as long as this document
 *  stays open — not a toast, so it can't scroll away or get missed. */
function makeModeToggle(): { btn: HTMLButtonElement; render: (m: PreviewMode, remote: boolean) => void } {
  const btn = el("button", "chrome-btn mode-toggle icon-only");
  const render = (m: PreviewMode, remote: boolean) => {
    btn.dataset.remote = String(remote);
    if (remote) {
      setButtonContent(btn, "lock", "읽기 전용 (원격)");
      btn.title = "읽기 전용 (원격) — 원격 볼트는 편집할 수 없습니다";
      return;
    }
    setButtonContent(btn, m === "edit" ? "square-pen" : "eye", m === "edit" ? "편집" : "리더");
    btn.title = m === "edit" ? "편집 모드 (⌘E: 리더 모드로)" : "리더 모드 (⌘E: 편집 모드로)";
  };
  return { btn, render };
}

async function boot() {
  // Dev-only QA bridge driver (single-window-opening Todo 6): lets the
  // native scripts/window-routing-smoke.mjs harness drive this real webview
  // over local HTTP instead of a browser mock. Statically folded to `false`
  // and dead-code-eliminated in `npm run build` (import.meta.env.DEV is a
  // Vite compile-time constant) — see src/qa/native-smoke-driver.ts.
  if (import.meta.env.DEV && import.meta.env.VITE_QA_BRIDGE) void import("./qa/native-smoke-driver");
  void unwatchFile();
  const migrateLegacyFavorites = shouldMigrateLegacyFavorites(
    localStorage.getItem(favoriteFoldersStorageKey) !== null,
    localStorage.getItem(favoriteVaultMigrationKey) === "1",
  );
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
  // --font-scale; --measure caps the reading column as a % of the window
  // width; --line-height the leading).
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
  readingWidthSetting.bind(cssVarSink("--measure", (pct: number) => `${pct}%`));
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
  const reloadHandoff = readDocumentReloadHandoff(location.search);
  const requestedFile = reloadHandoff.file;
  const workspaceStore = new WorkspaceStore();
  if (migrateLegacyFavorites) {
    try {
      await migrateFavoriteFoldersToVaults(
        workspaceStore,
        readLegacyFavoriteFolders(),
        // Leaf-site note (task-8a step 5): stays on localFileHost — this runs
        // once at boot, BEFORE any vault (remote included) is selected, over
        // legacy LOCAL favorite-folder paths from a pre-vault install. There
        // is no vault to route through yet; this predates the whole concept.
        async (path) => localFileHost.directoryExists(path),
        (path) => canonicalizeLegacyFavoriteFolder((candidate) => invoke("canonicalize_path", { path: candidate }), path),
      );
    } catch (error) {
      if (error instanceof Error || typeof error === "string") console.error("Failed to migrate favorite folders:", error);
      else throw error;
    }
  }
  if (reloadHandoff.globalExplorerRoot !== null) workspaceStore.selectVault(GLOBAL_VAULT_ID);
  const cliRoute = requestedFile && reloadHandoff.globalExplorerRoot === null ? await routeCliFileResolved(workspaceStore, requestedFile, async (path) => {
    try {
      const resolved: unknown = await invoke("canonicalize_path", { path });
      return typeof resolved === "string" ? resolved : path;
    } catch (error) {
      if (error instanceof Error || typeof error === "string") return path;
      throw error;
    }
  }) : undefined;
  const file = cliRoute?.path ?? requestedFile;
  // One-time recentDocsSetting migration (Task 11 fix round 3): the OLD
  // shape was a bare string[] with no vault identity. Runs here — AFTER any
  // CLI-arg permanent vault just got auto-registered above (`cliRoute`), so
  // a legacy recent path under that exact root resolves to it rather than
  // falling back to Global — and BEFORE the welcome pane / recent panel
  // below are ever asked to render. `readLegacyRecentDocPaths` is empty
  // (and this a no-op) on every boot after the first — see its own comment
  // for why no separate "completed" flag is needed.
  const legacyRecentPaths = readLegacyRecentDocPaths();
  if (legacyRecentPaths.length > 0) recentDocsSetting.set(migrateLegacyRecentPaths(workspaceStore, legacyRecentPaths));
  // Fixed default for clicking the Global Vault (00_request.md #2) — resolved
  // once at boot, not re-derived per click, so it can never observe a
  // mid-session `currentExplorerFolder` drift.
  const homeRoot = await resolveHomeRoot((path) => invoke<string>("canonicalize_path", { path }), SAFE_EXPLORER_BASE_PATH);
  const vaultTabs = new VaultTabStore();
  const conflictRecovery = createConflictRecovery();
  let routedVault = reloadHandoff.globalExplorerRoot !== null ? workspaceStore.getGlobalVault() : cliRoute?.vault;
  const selectedWorkspaceVault = (): Vault | undefined => {
    const workspace = workspaceStore.get().workspaces.find((item) => item.workspaceId === workspaceStore.get().currentWorkspaceId);
    return workspace?.currentVaultId ? workspaceStore.getVault(workspace.currentVaultId) : undefined;
  };
  const currentVault = () => {
    return routedVault ?? selectedWorkspaceVault();
  };
  // The vault root that OWNS the current document — image-search-root.ts's
  // `owningVaultRoot`, a pure function of the document's own path and the
  // registered permanent vaults, NEVER of `currentVault()` (which is app
  // state, not a document property). Both the render path
  // (setImageSearchRoot below) and the image.attach handler read through
  // THIS one function, so they can never drift onto two different rules
  // (design §분기4's single-SSOT requirement — see
  // _workspace/00_request_vaultimage_fix.md's 결함1 for why that drift is
  // exactly the bug this whole change reverts).
  const currentOwningVaultRoot = (): string | null =>
    currentFile ? owningVaultRoot(dirOf(currentFile), permanentRootsOf(workspaceStore.get())) : null;
  const routeDocumentPath = (path: string) => {
    const current = routedVault;
    if (current && routingTrustsCurrentVault(current.persistenceKind)) return current;
    const route = routeCliFile(workspaceStore, path);
    routedVault = route.vault;
    return route.vault;
  };
  const currentConflictIdentity = (): ConflictIdentity | null => {
    const vault = currentVault();
    if (!vault || !currentFile) return null;
    const tabs = vaultTabs.get(vault.vaultId);
    const tabId = tabs.tabs.find((tab) => tab.path === normalizePath(currentFile))?.tabId;
    return tabId ? { vaultId: vault.vaultId, tabId, documentId: `document-${normalizePath(currentFile)}` } : null;
  };
  const selectedVault = currentVault();
  const restoredTabs = selectedVault?.persistenceKind === "permanent" ? vaultTabs.get(selectedVault.vaultId) : null;
  const restoredTab = restoredTabs?.tabs.find((tab) => tab.tabId === restoredTabs.activeTabId)?.path ?? null;
  const initialFile = file || restoredTab || "";

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
  // Whether the CURRENTLY OPEN document belongs to a remote vault — set once
  // per `openInWindow` mount (see below), read by `syncModeIndicator`. Kept
  // as its own cell rather than re-deriving from `currentVault()` at render
  // time: `currentVault()` is APP-selection state (routedVault/workspace
  // selection) and can briefly point elsewhere mid vault-crossing switch
  // (see its own doc comment); this flag is a property of the document
  // `current` actually has mounted, set at the exact moment `mountEditor`
  // decided it (mirrors editor.ts's own `remoteReadOnly` local).
  let currentIsRemote = false;
  /** The CURRENTLY OPEN document's own vault id — same "property of the
   *  mounted document, not app-selection state" reasoning as `currentIsRemote`
   *  just above, set at the same site. Feeds `sessionStateKey` (Minor, final
   *  review): `currentFile` alone is not a unique document identity — a
   *  remote document's path is vault-relative ("노트.md"), so two different
   *  remote vaults with a same-named document at their root used to collide
   *  on the exact same `mermark.session.*` localStorage key. */
  let currentOpenVaultId: string | null = null;

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
  /** The mode indicator's single source of truth (Task 11): folds the global
   *  `modeSetting` and the open document's remote-forced read-only state into
   *  one render call, so the title-bar toggle can never show "편집" for a
   *  document that is actually uneditable. Bound to modeSetting's own change
   *  event AND called once more right after every mount (modeSetting alone
   *  doesn't change when a document with a DIFFERENT remote-ness opens while
   *  the setting itself stays "edit"). Command (void). */
  const syncModeIndicator = () => mode.render(modeSetting.get(), currentIsRemote);
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
  let currentFile = initialFile ?? "";
  let currentBaseDir = initialFile ? dirOf(initialFile) || SAFE_EXPLORER_BASE_PATH : SAFE_EXPLORER_BASE_PATH;
  let currentExplorerFolder = reloadHandoff.globalExplorerRoot ?? currentBaseDir;
  // A remote vault's `explorerRoot` is a virtual browsing root on the HOST,
  // not a path this window's local filesystem can `list_dir` — it must never
  // be confused with a LOCAL folder (task-2b brief: this exact confusion is
  // what made the local explorer jump to a bogus root before Task 10 gave
  // the Explorer a real remote-browsing surface). But since Task 10,
  // `getBaseDir` (the Explorer interface this function implements) already
  // routes every `listDir` through `fileHostFor(currentVault())` — which is
  // vault-kind-generic — so a remote vault's OWN `explorerRoot` (Task 10's
  // `registerRemoteVault`) is exactly the right thing to hand back, the same
  // way the permanent case hands back `vault.explorerRoot` instead of some
  // other local folder. Final review C1/I1: returning `currentExplorerFolder`
  // (a LOCAL folder) here instead was the bug — it made `jumpToRoot` refuse
  // to move (root-locked, and the local folder never equals the vault's real
  // root) and left every remote vault's Explorer stuck showing whatever
  // local tree was up before the vault was selected.
  const explorerRootForCurrentSelection = (): string => {
    const selected = selectedWorkspaceVault();
    if (shouldPreserveGlobalExplorerRoot(selected)) return currentExplorerFolder;
    const vault = currentVault();
    if (!vault) return currentBaseDir;
    const kind = vault.persistenceKind;
    switch (kind) {
      case "permanent": return vault.explorerRoot;
      case "global": return currentBaseDir;
      case "remote": return vault.explorerRoot;
      default: return assertNever(kind);
    }
  };
  // Entering the Global Vault always lands on HOME (00_request.md #2), never
  // wherever the explorer was last sitting (`currentExplorerFolder` — that's
  // still tracked for the reload-restore path and the breadcrumb while
  // browsing, just not as this button's default anymore).
  // Relies on PermanentVault.explorerRoot === rootPath always holding, which
  // the type does not enforce — pinned by tests/workspace-state.test.ts
  // ("registers canonical permanent vaults..." and "re-derives explorerRoot
  // from rootPath on reload...").
  // Task 10: a remote vault's `explorerRoot` (REMOTE_VAULT_WIRE_ROOT, "" —
  // see registerRemoteVault, workspace-state.ts) IS now a valid Explorer
  // target. Nothing else in the explorer needed to change to make this work:
  // `listDir` (below) already routes through `fileHostFor(currentVault())`,
  // which was ALWAYS vault-kind-generic (file-host.ts's makeFileHost switch)
  // — the only thing stopping remote browsing was this function itself
  // refusing to hand the explorer a root to jump to. `isRootLocked` already
  // returns true for remote (main.ts's own switch, above), so "up" past the
  // vault root is still refused exactly like a permanent vault.
  const explorerRootForVault = (vault: Vault): string | null => {
    const kind = vault.persistenceKind;
    switch (kind) {
      case "permanent": return vault.explorerRoot;
      case "global": return homeRoot;
      case "remote": return vault.explorerRoot;
      default: return assertNever(kind);
    }
  };
  // Command wrapper around `explorer.jumpToRoot`. `explorerRootForVault` now
  // resolves every vault kind to a real root (Task 10), so the `null` guard
  // below is unreachable today — kept because `explorerRootForVault`'s
  // return type stays `string | null` (a defensive width, not a live case),
  // and removing the guard would silently pass `null` straight to
  // `jumpToRoot` the day a future vault kind legitimately needs one again.
  const jumpExplorerToVaultRoot = (vault: Vault): void => {
    const root = explorerRootForVault(vault);
    if (root !== null) explorer.jumpToRoot(root);
  };
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
  // The per-file teardown closures the previous openInWindow installed (scroll
  // listener, pending session timer). teardownCurrent runs them before swap.
  let detachScroll: (() => void) | undefined;
  let cancelSessionTimer: (() => void) | undefined;
  let openConflict: { close(): void } | null = null;
  let openRecovery: RecoveryModalHandle | null = null;
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
  const closeConflict = (): void => {
    openConflict?.close();
    openConflict = null;
  };
  const closeRecovery = (): void => {
    openRecovery?.close();
    openRecovery = null;
  };

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
      // Viewer-vs-document is decided once, in `openPathEntry` (see its
      // comment for the bug this consolidation fixes — this used to be a
      // third hand-copied copy of that branch, right here). The document
      // branch stays prompt-specific: path-prompt.ts's onOpen contract needs
      // a failed open to both surface the recovery modal AND rethrow, so the
      // bar itself stays in editing with an inline error the user can act on
      // immediately — `openDocumentSafely` alone only does the former (it
      // swallows the error after showing recovery), so this branch calls
      // `openDocument` directly and does both itself.
      await openPathEntry(target, async (path, targetVault) => {
        try {
          await openDocument(path, undefined, undefined, targetVault);
          return true;
        } catch (error: unknown) {
          showOpenRecovery(path, String(error), targetVault);
          throw error;
        }
      });
    },
  });

  const showRecovery = (
    kind: RecoveryKind,
    detail: string,
    onAction: (action: RecoveryActionId) => RecoveryActionOutcome | Promise<RecoveryActionOutcome>,
    onCancel?: () => void,
  ): void => {
    closeRecovery();
    const handle = openRecoveryModal({
      state: createRecoveryState(kind, detail),
      onAction: async (action) => {
        const outcome = await onAction(action);
        if (outcome === "succeeded") openRecovery = null;
        return outcome;
      },
      onCancel: () => {
        openRecovery = null;
        onCancel?.();
      },
    });
    openRecovery = handle;
  };

  // I4 (final review): `vault` is the SAME explicit-vault-threading rule
  // Ruling 9/32/33 already closed at five other call sites in this file
  // (openDocument/navigateHistory/openWithViewer/openRecentEntry/the CLI open
  // path) — without it, "다시 시도" fell back to `openDocument`'s own
  // `currentVault()` default, which is the vault of whatever is SELECTED in
  // the sidebar, not necessarily the vault THIS failed read was for. A
  // remote vault selected in the sidebar while a local CLI/path-prompt open
  // fails would then retry through `remote_read_file` for a plain local
  // path — Ruling 33's exact symptom, one click later.
  // Minor (final review): a remote read failure used to reach the recovery
  // modal's diagnostic details as the raw `REMOTE:…` tag `remote_client.rs`
  // embeds in its `Err` string — the same four connection states the
  // sidebar badge already distinguishes (badgeFor/classifyRemoteError)
  // reduced to unlabeled text nowhere near where the user actually hit the
  // failure. Only remaps for a remote vault's failure; a local read error's
  // detail (a real filesystem error string) passes through unchanged.
  function recoveryDetailFor(detail: string, vault: Vault | undefined): string {
    return isRemoteVault(vault) ? badgeFor(classifyRemoteError(detail)).label : detail;
  }

  function showOpenRecovery(path: string, detail: string, vault?: Vault): void {
    showRecovery("open-read", recoveryDetailFor(detail, vault), async (action) => {
      if (action === "open-another") {
        prompt.button.click();
        return "succeeded";
      }
      if (action !== "retry") return "failed";
      try {
        await openDocument(path, undefined, undefined, vault);
        return "succeeded";
      } catch {
        return "failed";
      }
    });
  }
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

  // Viewer don't-stack slot (R11, _workspace/01_r11.md §5) — shared by every
  // registered viewer (image, and now extensions like Excel), same shape as
  // `openConflict` below: only one overlay at a time, opening a second closes
  // the first rather than stacking. Stays here, not in the registry — the
  // registry is a pure catalog (design §5: a stateful slot inside it would
  // repeat the God-object shape R9 explicitly avoided). The state machine
  // itself lives in dont-stack-slot.ts (extracted so its self-clear rule is
  // unit-testable — see tests/dont-stack-slot.test.ts); main.ts creates
  // exactly one instance and reads/writes it only through this object.
  const viewerSlot = createDontStackSlot();

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
  // The built-in SQLite/.db viewer — built-in for the same reason HWP is
  // (3 new Tauri commands: sqlite_tables/sqlite_table_info/sqlite_rows; R11's
  // extension contract is "frontend only, zero new IPC").
  registerSqliteViewer();
  // The built-in EPUB viewer (_workspace/01_architect_design_epub.md §0) —
  // built-in for the same reason (2 new Tauri commands: arm_epub_view/
  // read_epub_entry + a custom epub:// scheme). setTocOverride is the ONE
  // closure epub-viewer.ts is allowed to reach the outline panel through
  // (design §5: chrome/ never imports sidebar/ directly) — outline is
  // already in scope here (declared above, before this registration block).
  registerEpubViewer({ setTocOverride: (items) => outline.setOverride(items) });

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

  /** Open `absPath` in its registered viewer via the don't-stack slot. The
   *  single owner of that rule — every viewer open (built-in image, any
   *  extension) for an on-disk file funnels through here. No-op if no viewer
   *  claims the file (defensive; canOpenWithViewer should already have gated
   *  the caller).
   *
   *  `targetVault` is REQUIRED (not read from `currentVault()` internally) —
   *  Task 11 fix round 1's finding: `currentVault()` is the SIDEBAR's
   *  selection, which can name a remote vault while `absPath` is a raw LOCAL
   *  filesystem path (a CLI launch, or the open-path prompt) that has
   *  nothing to do with it. Trusting `currentVault()` here refused a
   *  perfectly valid local EPUB with the remote "아직 지원하지 않습니다"
   *  message whenever a remote vault happened to be selected — the same
   *  class of bug `resolveTargetVault`/Explorer's `onOpenFile` `targetVault`
   *  already exist to prevent (see their own comments) for document opens.
   *  Every caller below now threads the vault it actually means. Command (void). */
  function openWithViewer(absPath: string, targetVault: Vault): void {
    const v = viewerForEntry(basename(absPath));
    if (!v) return;
    // Remote vaults (v1, read-only) only ever serve markdown + images through
    // `remote_read_file`/asset-src reads — every OTHER registered viewer's
    // open() reads through a Tauri command or local-disk path with no remote
    // counterpart (remote-capability.ts's own doc comment has the full list).
    // Refuse with an explicit, visible message here rather than letting the
    // viewer open and fail silently/partially (this repo forbids silent
    // degradation) — the row itself stays clickable, it just reports the
    // truth instead of opening a broken pane.
    if (isRemoteVault(targetVault) && !remoteCanOpen(basename(absPath))) {
      save.set("error", remoteUnsupportedMessage(basename(absPath)));
      return;
    }
    const handle = viewerSlot.open(() => v.open(absPath));
    // The footer breadcrumb points at the folder of whatever the CONTENT AREA
    // is showing. While the viewer was a floating modal OVER the document,
    // "current folder" unambiguously meant the document's; a full-pane viewer
    // IS the content now, so leaving it on the document's folder pointed
    // somewhere the user isn't (사용자 리포트 2026-07-19: "브레드크럼프가
    // 업데이트가 안되고있네"). `onClose` (not just our own close() calls)
    // restores it, so an Esc/✕ close the slot never initiated still returns
    // the breadcrumb to the live document's folder. `currentBaseDir` is read
    // at close time, so a document switch that happened meanwhile still wins.
    breadcrumb.render(dirOf(absPath));
    handle.onClose(() => breadcrumb.render(currentBaseDir));
  }

  /** Open `path` the way anything OUTSIDE the live editor is allowed to —
   *  an explorer row, a file-finder result, the open-path prompt, a CLI
   *  launch/routed request. This is the ONE place the "viewer or document"
   *  judgment happens: a filename a registered, enabled viewer claims
   *  (pdf/epub/hwp/image/xlsx/docx/sqlite/…) goes to that viewer via
   *  `openWithViewer`, NOT through `openDoc` — the same `viewerForEntry`
   *  gate the explorer and search results already apply before opening
   *  anything. Before this function existed, the CLI cold-launch mount and
   *  the `cli-open-request` listener were the two entry points that skipped
   *  this gate entirely and read every file as a text document: launching
   *  `mermark foo.pdf` (or routing a second `mermark foo.pdf` into an
   *  already-open window) failed with `stream did not contain valid UTF-8`
   *  (사용자 리포트 2026-08-17), while clicking the very same file in the
   *  explorer opened it fine. Every path-opening entry point now funnels
   *  through here so none can drift onto its own hand-copied branch again.
   *
   *  A viewer open never runs `openDoc`'s unsaved-work guard: the viewer
   *  occupies its own don't-stack slot rather than replacing the live
   *  document, so there is nothing to guard and no failure mode for this
   *  function to report on that branch. `openDoc` stays each caller's own
   *  document-open strategy — `openDocumentSafely`'s safe transaction for
   *  every caller except the open-path prompt, which supplies its own
   *  rethrowing variant so a failed open both surfaces the recovery modal
   *  AND keeps the bar itself in editing with an inline error. This
   *  function only picks the branch; it never changes how a caller's own
   *  failure handling behaves. Resolves "opened" once a branch has been
   *  dispatched (viewer: always; document: iff `openDoc` reports success)
   *  or "recovered" when the document branch fails but stays visibly
   *  reported (never silently dropped) — the exact vocabulary
   *  `acknowledge_open_request` needs, reused by every other caller as a
   *  plain success/fail signal.
   *
   *  Every caller here (CLI launch/route, the open-path prompt, the
   *  boot-time initial file) hands in a raw LOCAL filesystem path — never a
   *  vault-relative remote path (a remote vault has no restored tabs to
   *  reopen this way; see `restoredTabs`'s own `persistenceKind === "permanent"`
   *  guard) — so BOTH branches resolve their vault via `routeCliFile`
   *  (path-based: the permanent vault whose root actually contains `path`,
   *  else the Global Vault), the SAME local-only resolution `routeDocumentPath`
   *  falls back to for a non-trusted vault, computed ONCE here and handed to
   *  whichever branch runs. This deliberately does NOT consult
   *  `currentVault()`/`routedVault`: those name whatever vault is currently
   *  SELECTED in the sidebar, which can be a remote vault with nothing to do
   *  with this path. Task 11 fix round 1 caught this for the viewer branch;
   *  round 2 found the SAME bug, live, in the document branch — every
   *  `openDoc` caller below now receives (and must thread through) the
   *  resolved `targetVault` instead of leaving it to `openDocument`'s own
   *  `currentVault() ?? global` fallback. */
  async function openPathEntry(
    path: string,
    openDoc: (path: string, targetVault: Vault) => Promise<boolean>,
  ): Promise<"opened" | "recovered"> {
    const targetVault = routeCliFile(workspaceStore, path).vault;
    if (viewerForEntry(basename(path))) {
      openWithViewer(path, targetVault);
      return "opened";
    }
    return (await openDoc(path, targetVault)) ? "opened" : "recovered";
  }

  /** Wired to image.ts's `requestImageOpen` (via `setImageOpenHandler`,
   *  below) — what actually happens when a clicked image widget in the
   *  editor asks to open. Mirrors the explorer's own gating
   *  (`isViewerEnabled`) so turning the image viewer off in settings makes
   *  an editor click a no-op too, rather than a second "always opens" path
   *  that disagrees with the explorer. A remote/data source has no
   *  registered-viewer entry (`viewerForEntry` keys off a file EXTENSION),
   *  so it goes straight into the slot with `openImageViewer` — skipping
   *  `openWithViewer`'s breadcrumb rewrite, since there is no on-disk folder
   *  to point the breadcrumb at. A local absolute path reuses `openWithViewer`
   *  as-is (breadcrumb included), the same path the explorer already takes.
   *  A local `source` belongs to the CURRENTLY MOUNTED document, not to
   *  whatever the sidebar happens to have selected — `currentVault()` is
   *  correct here (no ambiguity: this fires from a click inside the document
   *  that IS the open one, so it can't be mid-vault-crossing-switch the way
   *  a fresh open can). Command (void). */
  function openImageFromEditor(source: string): void {
    if (!isViewerEnabled(disabledViewersSetting.get(), "image")) return;
    if (isRemoteSrc(source)) {
      viewerSlot.open(() => openImageViewer(source));
      return;
    }
    openWithViewer(source, currentVault() ?? workspaceStore.getGlobalVault());
  }
  setImageOpenHandler(openImageFromEditor);

  /** "Opening a document closes any open viewer" (full-pane rewrite,
   *  _workspace/01_architect_design.md §A rule 1) — a body-level modal was
   *  harmless to leave open under a newly-opened document (it floated on
   *  top, dismissible independently), but a full-PANE viewer now occupies
   *  `.editor-host`'s own spot: opening a document without closing the
   *  viewer first would mount the new document behind a still-visible pane.
   *  `openInWindow` calls this as its very first statement, so every
   *  document-open path (explorer/recent/history/prompt — all funnel through
   *  `openInWindow`) gets the rule for free from one call site. This is the
   *  slot's unconditional "clear it, full stop" writer (`viewerSlot.closeAll`)
   *  — `viewerSlot.open` (used by `openWithViewer`/`openImageFromEditor`) is
   *  the other, and its own self-clear only nulls the slot when the closing
   *  handle is still the CURRENT one (see dont-stack-slot.ts), so the two
   *  writers never race. main.ts never assigns the slot directly — every
   *  read/write funnels through `viewerSlot` (code-auditor focus per plan's
   *  handoff). Command (void). */
  function closeOpenViewer(): void {
    viewerSlot.closeAll();
  }

  /** ⌘/Ctrl+click or ⌘+Enter's "open this row in a brand-new window" action,
   *  shared by the Explorer and the file-finder search panel (final review
   *  I3). `open_path` is a LOCAL-filesystem command — a remote row's path is
   *  vault-relative ("노트.md"), which either silently fails (console-only,
   *  nothing the user sees — spec §6 forbids exactly this) or, if the
   *  process's CWD happens to hold a same-named file, opens THAT unrelated
   *  local file in the new window under the remote note's name. Refuses
   *  visibly instead, the same message `standardLinkRejectionFor` already
   *  uses for the analogous remote-link case. */
  function openInNewWindow(absPath: string, vault: Vault | undefined): void {
    if (isRemoteVault(vault)) {
      save.set("error", REMOTE_VAULT_LOCAL_LINK_MESSAGE);
      return;
    }
    invoke("open_path", { path: absPath }).catch((err) => {
      console.error("Failed to open in a new window", err);
    });
  }

  const explorer = createExplorerPanel({
    listDir: (p) =>
      fileHostFor(currentVault() ?? workspaceStore.getGlobalVault()).listDir(p, showHiddenFilesSetting.get() === "on"),
    getBaseDir: explorerRootForCurrentSelection,
    onOpenFile: async (absPath) => {
      const openVault = currentVault();
      // The cold-start reload (below) carries the target through the URL so
      // the NEXT boot can re-derive which vault owns it — createDocumentReloadUrl
      // only ever encodes a local/global root (routeCliFileResolved, called at
      // boot, can only resolve "permanent" or "global" — see
      // routingTrustsCurrentVault's doc comment). A remote document's path is
      // vault-relative and carries no such information, so a reload would
      // strand the user back on the Global Vault welcome screen instead of
      // reopening it. Opening in-place is strictly correct for remote
      // regardless of whether a document is already open elsewhere in this
      // window — there is no "first-ever open" special case for remote to
      // begin with, since a reload could never have served it anyway.
      if (!currentFile && openVault?.persistenceKind !== "remote") {
        location.href = createDocumentReloadUrl(absPath, openVault?.persistenceKind === "global" ? currentExplorerFolder : null);
      } else if (openVault?.persistenceKind === "remote") {
        // Explicit targetVault (Ruling 9's resolveTargetVault pattern) — not
        // optional here the way it is for permanent. routeDocumentPath's
        // fallback (routeCliFile) can only ever land on "permanent" or
        // "global" (its own doc comment); a vault-relative remote path like
        // "노트.md" matches no registered permanent root and would silently
        // fall through to the Global Vault — reading (and re-saving any tab
        // state for) the WRONG vault even though the Explorer, one line
        // above, is unambiguously already browsing this remote vault via the
        // very same `currentVault()`.
        openDocumentSafely(absPath, undefined, openVault);
      } else {
        openDocumentSafely(absPath);
      }
    },
    // SAME RULE as `openPathEntry` above, expressed as a predicate + a command
    // instead of one call. The panels need the QUESTION ("is this row even
    // openable?") separately from the ACT of opening — a row's clickability is
    // decided at tree-render time, long before anyone clicks — so they cannot
    // be served by `openPathEntry` alone. Both spellings bottom out in the same
    // `viewerForEntry`/`openWithViewer` pair, which is what keeps them from
    // drifting; if you add a new way to open a path, reach for `openPathEntry`,
    // not for a third copy of this branch.
    canOpenWithViewer: (name) => viewerForEntry(name) != null,
    // The Explorer is unambiguously browsing `currentVault()` (same fact
    // `onOpenFile`'s remote branch above already relies on) — thread it
    // explicitly rather than have `openWithViewer` consult `currentVault()`
    // itself (Task 11 fix round 1: that pattern is exactly what let a CLI/
    // prompt-launched LOCAL path get misjudged against an unrelated
    // sidebar-selected remote vault).
    onOpenWithViewer: (absPath) => openWithViewer(absPath, currentVault() ?? workspaceStore.getGlobalVault()),
    // ⌘/Ctrl+click or ⌘+Enter on a markdown row: open it in a brand-new
    // window (or refuse visibly for a remote row — I3, openInNewWindow).
    // The Explorer is unambiguously browsing `currentVault()`, same as
    // `onOpenWithViewer` just above.
    onOpenFileNewWindow: (absPath) => openInNewWindow(absPath, currentVault()),
    onOpen: () => closeOtherSidebarPanels("explorer"),
    onRootChange: (root) => {
      if (currentVault()?.persistenceKind === "global") currentExplorerFolder = root;
      breadcrumb.render(root);
    },
    onToggleVault: (root) => toggleExplorerVault(root),
    isVaultRegistered: (root) => isVaultRegistered(root),
    isRootLocked: () => isVaultRootLocked(currentVault()),
    // I2: a remote listing has no local folder to bookmark — the toggle
    // (and its Space-key shortcut) must not even render there, or clicking
    // it sends a vault-relative name into a LOCAL canonicalize_path call.
    canBookmarkFolders: () => !isRemoteVault(currentVault()),
  });

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
  const openDocument = async (
    absPath: string,
    requestId = beginLifecycleRequest(),
    onCommit?: () => void,
    targetVault?: Vault,
  ): Promise<boolean> => {
    const sourceEditor = current;
    const readVault = resolveTargetVault(targetVault, currentVault(), workspaceStore.getGlobalVault());
    let fresh: { text: string; mtime: number };
    try {
      fresh = await fileHostFor(readVault).readFile(absPath);
    } catch (error: unknown) {
      if (requestId === lifecycleRequest) throw error;
      return false;
    }
    if (requestId !== lifecycleRequest || !(await commitBeforeSwitch()) || requestId !== lifecycleRequest) {
      if (sourceEditor && current === sourceEditor) sourceEditor.resumeWrites();
      return false;
    }
    if (!(await watcherHandoff.handoff(absPath, readVault)) || requestId !== lifecycleRequest) {
      if (sourceEditor && current === sourceEditor) sourceEditor.resumeWrites();
      return false;
    }
    onCommit?.();
    openInWindow(absPath, fresh, {}, targetVault);
    return true;
  };
  const openDocumentSafely = (absPath: string, onCommit?: () => void, targetVault?: Vault): Promise<boolean> => {
    const requestId = beginLifecycleRequest();
    return openDocument(absPath, requestId, onCommit, targetVault).catch((error: unknown) => {
      if (requestId === lifecycleRequest) showOpenRecovery(absPath, String(error), targetVault);
      return false;
    });
  };

  // CLI file-open routing (single-window-opening Todo 2): the backend's
  // single-instance broker queues an ordinary `mermark <file>` request from a
  // second process until this webview registers ready, then delivers it
  // recipient-scoped via `emit_to(WebviewWindow{label})`. The listener MUST be
  // registered before `register_window_ready` is invoked — once the backend
  // sees this window as ready, it emits immediately, and a request emitted
  // before the listener exists is lost. `openPathEntry` decides viewer vs
  // document first (see its comment — this listener used to skip that
  // judgment entirely and hand every routed path straight to
  // `openDocumentSafely`, so a routed `mermark foo.pdf` tried to read the
  // PDF as text and failed). A viewer open always reports "opened" (no
  // unsaved-work guard to fail); the document branch still resolves through
  // `openDocumentSafely`, which already surfaces a visible recovery state on
  // failure/supersede (resolves false rather than throwing) — so `outcome`
  // alone tells the backend whether to retain the request as "recovered"
  // (still-visible, not silently dropped) or drop it as delivered ("opened").
  const registerCliOpenRouting = async (): Promise<void> => {
    const label = getCurrentWindow().label;
    await listen<{ id: number; path: string }>(
      "cli-open-request",
      async (e) => {
        const outcome = await openPathEntry(e.payload.path, (path, targetVault) => openDocumentSafely(path, undefined, targetVault));
        void invoke("acknowledge_open_request", { id: e.payload.id, outcome });
      },
      { target: label },
    );
    void invoke("register_window_ready");
  };

  // ── Document-open seam (Todo 3): 렌더러(위키링크/표준 로컬 링크)의 문서 열기 요청을
  //    현재 창의 안전 트랜잭션으로 보낸다. setImageOpenHandler(위)와 평행한 plain-module 슬롯.
  setDocumentOpenHandler((request) => {
    if (request.kind === "resolved-document") {
      void openDocumentSafely(request.path);
      return;
    }
    const vault = currentVault();
    // Item 4 decision (standardLinkRejectionFor, Ruling 10 — local-doc-link.ts's
    // header comment has the full reasoning): checked BEFORE building
    // `context` (which already gates non-"permanent" vaults to `null`,
    // generically) so a remote-vault click gets the specific "원격 볼트는"
    // wording instead of the permanent-vault-only generic reason.
    const rejection = standardLinkRejectionFor(vault);
    if (rejection) {
      markLocalLinkFailure(request.feedbackEl, rejection);
      return;
    }
    const context =
      vault?.persistenceKind === "permanent" && currentFile
        ? { documentPath: currentFile, vaultRootPath: vault.rootPath }
        : null;
    void openStandardLocalLink(request, context, openDocumentSafely);
  });

  // ── Vault-root image search seam (`vault:` scheme withdrawal —
  //    _workspace/00_request_vaultimage_fix.md): wires `currentOwningVaultRoot`
  //    (defined above, alongside currentVault) as the provider `![[name]]`'s
  //    onerror fallback (image.ts's vault-scope search) reads through
  //    `imageSearchRoot()`. Document-derived, not app-state-derived — the
  //    fix for the exact bug (링크가 문서가 아니라 앱 상태로 해석된다) the
  //    old `setVaultImageContext(() => currentVault()...)` wiring had.
  setImageSearchRoot(currentOwningVaultRoot);
  // dev-only: expose vault-routing state for the native QA harness
  // (scripts/window-routing-smoke.mjs) to read via queryDoc's debugVault
  // field on a timeout — same DEV gate as `window.__mermark` above.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
    (window as unknown as { __mermarkDebugVault?: unknown }).__mermarkDebugVault = {
      currentVault: currentVault(),
      workspaceState: workspaceStore.get(),
      requestedFile,
      globalExplorerRoot: reloadHandoff.globalExplorerRoot,
    };

  /** Open a recent-documents entry (welcome pane / recent panel share this —
   *  same resolution, same failure mode). Resolves the vault the entry
   *  actually belongs to from `entry.vaultId` (`workspaceStore.getVault`),
   *  never from `currentVault()` — Task 11 fix round 3: recentDocsSetting
   *  used to be a bare path list with no vault identity, so opening a
   *  recent entry silently read through whichever vault happened to be
   *  selected at click time, not the one that recorded the entry. A vault
   *  that no longer exists (removed/unpaired since the entry was recorded)
   *  fails loudly via the status bar rather than throwing or silently
   *  falling back to whatever is currently selected. Mirrors Explorer's own
   *  `onOpenFile` reload-vs-open-in-place branch (Task 10): a remote vault
   *  has no way to encode itself in a reload URL, so it always opens in
   *  place instead. Command (void). */
  async function openRecentEntry(entry: RecentEntry): Promise<void> {
    const targetVault = workspaceStore.getVault(entry.vaultId);
    if (!targetVault) {
      save.set("error", "이 최근 문서가 속한 볼트를 찾을 수 없습니다 (삭제되었거나 연결이 해제됨)");
      return;
    }
    if (!currentFile && targetVault.persistenceKind !== "remote") {
      location.href = createDocumentReloadUrl(entry.path, targetVault.persistenceKind === "global" ? currentExplorerFolder : null);
      return;
    }
    await openDocumentSafely(entry.path, undefined, targetVault);
  }

  const welcomePane = createWelcomePane({
    getRecent: () => recentDocsSetting.get(),
    onOpenFile: openRecentEntry,
    onOpenFolder: () => explorer.button.click(),
    openFolderChord: (() => {
      const bound = effectiveBinding("explorer.toggle");
      return bound ? displayChord(bound) : null;
    })(),
  });

  // The local filesystem folder the welcome pane anchors "open a file"
  // dialogs to once no document is open. A permanent vault anchors to its own
  // registered root, same as always. A remote vault has NO local filesystem
  // presence to anchor to yet (v1 is read-only network browsing — Task 10+
  // wires actual host listing, not a local path) — using its virtual
  // `explorerRoot` here would hand a host-side string to a local `dirOf`/open
  // dialog, so it falls back to `currentExplorerFolder`, same safe default as
  // the Global Vault.
  const baseDirForVault = (vault: Vault | undefined): string => {
    if (!vault) return currentExplorerFolder;
    const kind = vault.persistenceKind;
    switch (kind) {
      case "permanent": return vault.rootPath;
      case "global": return currentExplorerFolder;
      case "remote": return currentExplorerFolder;
      default: return assertNever(kind);
    }
  };

  const renderWelcomeForVault = (): void => {
    closeOpenViewer();
    closeConflict();
    closeRecovery();
    teardownCurrent();
    currentFile = "";
    explorer.setActiveFile(null); // no document open — clear the tree highlight
    const vault = currentVault();
    currentBaseDir = baseDirForVault(vault);
    host.classList.add("welcome-host");
    host.append(welcomePane);
  };

  function discardCurrentDocument(editor: EditorController, file: string): void {
    if (current !== editor || currentFile !== file) return;
    const vault = currentVault();
    const identity = currentConflictIdentity();
    if (vault && identity) {
      const scope = tabScopeForVault(vault);
      vaultTabs.close(vault.vaultId, identity.tabId, scope);
    }
    renderWelcomeForVault();
  }

  function showDocumentRecovery(kind: "deleted" | "unreadable" | "save", detail: string): void {
    const editor = current;
    const file = currentFile;
    if (!editor || !file) return;
    showRecovery(kind, detail, async (action) => {
      if (current !== editor || currentFile !== file) return "failed";
      if (action === "retry") return (await editor.retryOriginal()) ? "succeeded" : "failed";
      if (action === "save-recovered-copy") return (await editor.saveRecoveredCopy()) ? "succeeded" : "failed";
      if (action === "save-as") {
        const target = window.prompt("다른 이름으로 저장할 경로", `${file}.recovered.md`);
        if (target === null) return "cancelled";
        return (await editor.saveAs(target)) ? "succeeded" : "failed";
      }
      if (action === "close-discard") {
        discardCurrentDocument(editor, file);
        return "succeeded";
      }
      return "failed";
    }, () => editor.resumeWrites());
  }

  const canonicalizeVaultPath = async (root: string): Promise<string> => {
    const resolved: unknown = await invoke("canonicalize_path", { path: root });
    if (typeof resolved !== "string") {
      throw new WorkspaceStateError("invalid-path", "폴더 경로를 정규화할 수 없습니다");
    }
    return normalizePath(resolved);
  };

  const isVaultRegistered = async (root: string): Promise<boolean> => {
    const canonical = await canonicalizeVaultPath(root);
    return workspaceStore.get().vaults.some((vault) => vault.rootPath === canonical);
  };

  const toggleExplorerVault = (root: string): void => {
    void (async (): Promise<void> => {
      try {
        const canonical = await canonicalizeVaultPath(root);
        const existing = workspaceStore.get().vaults.find((vault) => vault.rootPath === canonical);
        if (existing) {
          const wasCurrent = currentVault()?.vaultId === existing.vaultId;
          workspaceStore.unregisterVault(existing.vaultId);
          if (wasCurrent) routedVault = undefined;
        } else {
          const wasGlobal = currentVault()?.persistenceKind === "global";
          const registered = workspaceStore.registerCanonicalVault(canonical);
          if (wasGlobal) {
            workspaceStore.selectVault(GLOBAL_VAULT_ID);
            routedVault = workspaceStore.getGlobalVault();
          } else {
            routedVault = registered;
          }
        }
      } catch (error) {
        if (error instanceof WorkspaceStateError || error instanceof Error || typeof error === "string") {
          window.alert(error instanceof Error ? error.message : error);
          return;
        }
        throw error;
      }
    })();
  };

  const workspaceSidebar = createWorkspaceSidebar({
    store: workspaceStore,
    onOpen: () => closeOtherSidebarPanels("workspace"),
    onSelectVault: (vault) => {
      const selectedVault = workspaceStore.getVault(vault.vaultId) ?? vault;
      const previousVaultId = currentVault()?.vaultId;
      const selection = selectVaultView(vaultTabs.get(selectedVault.vaultId));
      if (selection.kind === "document") {
        // Entering a vault by name always means "open the explorer on this
        // vault" (team-lead diagnosis, 2026-08-17) — jumpToRoot lives INSIDE
        // commitSelection, not bolted on beside it, so both call sites below
        // (the async open-a-different-doc path via onCommit, and the
        // synchronous same-doc reclick path) get it exactly once. Placed
        // AFTER routedVault is reassigned so jumpToRoot's own isRootLocked
        // check (explorer-panel.ts) reads the NEW vault, not the one being
        // left — a locked (permanent) vault would otherwise compare its OLD
        // root against the new target and silently refuse to move.
        const commitSelection = (): void => {
          workspaceStore.selectVault(selectedVault.vaultId);
          routedVault = selectedVault;
          jumpExplorerToVaultRoot(selectedVault);
        };
        if (previousVaultId !== selectedVault.vaultId || selection.tab.path !== normalizePath(currentFile)) openDocumentSafely(selection.tab.path, commitSelection, selectedVault);
        else commitSelection();
      } else {
        const requestId = beginLifecycleRequest();
        const sourceEditor = current;
        void commitBeforeSwitch().then(async (saved) => {
          if (!saved || requestId !== lifecycleRequest || !(await watcherHandoff.handoff(undefined)) || requestId !== lifecycleRequest) {
            if (sourceEditor && current === sourceEditor) sourceEditor.resumeWrites();
            return;
          }
          workspaceStore.selectVault(selectedVault.vaultId);
          routedVault = selectedVault;
          renderWelcomeForVault();
          jumpExplorerToVaultRoot(selectedVault);
        });
      }
    },
    onSelectTab: (vault, tab) => {
      const selectedVault = workspaceStore.get().vaults.find((candidate) => candidate.vaultId === vault.vaultId) ?? vault;
      const scope = tabScopeForVault(selectedVault);
      return openDocumentSafely(tab.path, () => {
        workspaceStore.selectVault(selectedVault.vaultId);
        routedVault = selectedVault;
        vaultTabs.select(selectedVault.vaultId, tab.tabId, scope);
      }, selectedVault);
    },
    onCloseTab: (vault, tab) => {
      const currentTabs = vaultTabs.get(vault.vaultId);
      const wasActive = currentTabs.activeTabId === tab.tabId;
      const scope = tabScopeForVault(vault);
      if (!wasActive || currentVault()?.vaultId !== vault.vaultId) {
        vaultTabs.close(vault.vaultId, tab.tabId, scope);
        return;
      }
      const requestId = beginLifecycleRequest();
      const sourceEditor = current;
      void (async (): Promise<void> => {
        const remainingTabs = currentTabs.tabs.filter((candidate) => candidate.tabId !== tab.tabId);
        const nextTab = remainingTabs[remainingTabs.length - 1];
        let fresh: { text: string; mtime: number } | undefined;
        if (nextTab) {
          try {
            fresh = await fileHostFor(vault).readFile(nextTab.path);
          } catch (error: unknown) {
            if (requestId === lifecycleRequest) showOpenRecovery(nextTab.path, String(error), vault);
            return;
          }
        }
        if (requestId !== lifecycleRequest || !(await commitBeforeSwitch()) || requestId !== lifecycleRequest) {
          if (sourceEditor && current === sourceEditor) sourceEditor.resumeWrites();
          return;
        }
        if (!(await watcherHandoff.handoff(nextTab?.path, vault)) || requestId !== lifecycleRequest) {
          if (sourceEditor && current === sourceEditor) sourceEditor.resumeWrites();
          return;
        }
        const nextTabs = vaultTabs.close(vault.vaultId, tab.tabId, scope);
        routedVault = vault;
        const selection = selectVaultView(nextTabs);
        if (selection.kind === "document" && fresh) openInWindow(selection.tab.path, fresh, {});
        else renderWelcomeForVault();
      })();
    },
    getTabs: (vaultId) => vaultTabs.get(vaultId),
  });
  workspaceStore.subscribe(() => { void explorer.refreshVaultToggles(); });
  vaultTabs.subscribe(() => workspaceSidebar.refresh());

  // ── Recent documents LEFT SIDEBAR. Same toggle shape as explorer/outline; the
  //    list is read from recentDocsSetting (SSOT — the panel never writes it)
  //    and a click reuses main's open transaction. An unavailable entry stays
  //    visible so its recovery flow can retry it. The panel re-renders from a
  //    single recentDocsSetting.subscribe below. ────────────────────────────────
  const recent = createRecentPanel({
    getRecent: () => recentDocsSetting.get(),
    onOpenFile: openRecentEntry,
    onOpen: () => closeOtherSidebarPanels("recent"),
  });

  // ── File finder LEFT SIDEBAR panel (⌘⇧F) — VS Code ⌘P-style filename fuzzy
  //    quick-open over ONE recursive scan of the current explorer root (or
  //    currentBaseDir when the explorer has never been opened — same
  //    fallback shape as getBaseDir above). onOpenFile/onOpenFileNewWindow/
  //    canOpenWithViewer mirror explorer's own wiring exactly (same
  //    viewerForEntry/open_path/read_file calls), so the two panels can never
  //    disagree about what's openable. list_files_recursive is READ-ONLY
  //    (backend-engineer's command; see _workspace/01_architect_design.md
  //    §보안·성능) — no atomic-write/conflict-guard surface touched. ───────
  // `searchScanVault` captures the vault a scan actually ran against, so
  // `onOpenFile` (below) resolves through THAT vault rather than re-reading
  // `currentVault()` at click time — Task 11 fix round 3: the sidebar's
  // selection can change while the search panel stays open (nothing closes
  // it on a vault switch), so re-deriving at click time could read a result
  // through a vault it was never scanned from.
  let searchScanVault: Vault | undefined;
  const searchPanel = createSearchPanel({
    scan: (root) => {
      searchScanVault = currentVault() ?? workspaceStore.getGlobalVault();
      return fileHostFor(searchScanVault).listFilesRecursive(root, showHiddenFilesSetting.get() === "on");
    },
    getRoot: () => explorer.currentRootPath() ?? currentBaseDir,
    onOpenFile: async (absPath) => {
      const targetVault = searchScanVault ?? currentVault() ?? workspaceStore.getGlobalVault();
      if (!currentFile && targetVault.persistenceKind !== "remote") {
        location.href = createDocumentReloadUrl(absPath, targetVault.persistenceKind === "global" ? currentExplorerFolder : null);
      } else {
        await openDocumentSafely(absPath, undefined, targetVault);
      }
    },
    // I3: same visible refusal as the Explorer's onOpenFileNewWindow above,
    // routed through the same `searchScanVault` this panel's own onOpenFile
    // (just above) already uses for the analogous "which vault is this row
    // in" question.
    onOpenFileNewWindow: (absPath) => openInNewWindow(absPath, searchScanVault ?? currentVault() ?? workspaceStore.getGlobalVault()),
    // SAME RULE as `openPathEntry` above, expressed as a predicate + a command
    // instead of one call. The panels need the QUESTION ("is this row even
    // openable?") separately from the ACT of opening — a row's clickability is
    // decided at tree-render time, long before anyone clicks — so they cannot
    // be served by `openPathEntry` alone. Both spellings bottom out in the same
    // `viewerForEntry`/`openWithViewer` pair, which is what keeps them from
    // drifting; if you add a new way to open a path, reach for `openPathEntry`,
    // not for a third copy of this branch.
    canOpenWithViewer: (name) => viewerForEntry(name) != null,
    onOpen: () => closeOtherSidebarPanels("search"),
  });

  // Title-bar order (single contract, arrangeTitleBar owns it): leftGroup
  // (탐색기 · 최근 · 목차 · 경로열기) · [drag spacer] · 모드 · 테마 · ⚙,
  // window-controls always last (win/linux). createSettingsButton only builds
  // the button + lazy modal wiring —
  // position is this call's job, not modal.ts's (M2 decision). R9: leftGroup
  // now starts with only openPath — registerSidebarPanel below inserts the
  // three panel toggle buttons before it, in registration order, so the
  // "탐색기·최근·목차 first, then open-path" contract is still upheld even
  // though the group is no longer built with all four in one call.
  const leftGroup = createLeftCommandGroup({ openPath: prompt.button });
  arrangeTitleBar(titleBar.el, {
    leftGroup,
    titleSlot: createTitleSlot(),
    viewerSlot: createViewerSlot(),
    mode: mode.btn,
    theme: themeBtn.btn,
    settings: createSettingsButton(() => shareableVaultsFrom(workspaceStore.get())),
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
  registerSidebarPanel({ id: "workspace", button: workspaceSidebar.button, aside: workspaceSidebar.aside, close: workspaceSidebar.close });
  registerSidebarPanel({ id: "explorer", button: explorer.button, aside: explorer.aside, close: explorer.close });
  registerSidebarPanel({ id: "recent", button: recent.button, aside: recent.aside, close: recent.close });
  registerSidebarPanel({ id: "outline", button: outline.button, aside: outline.aside, close: outline.close });
  registerSidebarPanel({ id: "search", button: searchPanel.button, aside: searchPanel.aside, close: searchPanel.close });
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
  // A viewer toggle (settings panel) changes what `canOpenWithViewer` answers
  // for already-rendered rows, but explorer bakes `.is-nonmd` in at render
  // time and never re-asks on click (explorer-panel.ts's activateItem short-
  // circuits on the cached class) — so without this, disabling a viewer
  // mid-session left its already-rendered rows still "openable" and a click
  // fell through to onOpenFile, opening a non-markdown file AS markdown.
  // subscribe (not bind): the initial renderTree already saw the setting's
  // boot value, so a bind here would just re-run the same refresh redundantly
  // on every mount. Explorer owns no state here — this is a pure DOM sink,
  disabledViewersSetting.subscribe(() => explorer.refreshOpenability());
  // showHiddenFiles changes the listing CONTENT (dotfiles appear/disappear),
  // not just a rendered row's state — refreshListing clears childrenCache and
  // re-reads the current root so the next listDir() call picks up the new
  // showHidden value (read at call time via the closure above, not cached).
  showHiddenFilesSetting.subscribe(() => explorer.refreshListing());

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
        if (!openRecovery) showDocumentRecovery("save", "전환 전에 저장하지 못했습니다");
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

  /** Mount `file`'s content as the live editor in `host`, re-pointing every
   *  per-file binding (doc, baseDir for images/wikilinks, autosave target +
   *  mtime baseline, session key) by going through the verified mountEditor
   *  boot path. Tears down any previous editor first. Mode/vim are preserved
   *  from the live settings (a re-open keeps your edit/read + vim state). */
  /** Reconcile the explorer (tree + breadcrumb) with a document that just
   *  became `currentFile`, and mark it as the tree's active-highlight target.
   *  Runs the domain rule "opening a document is not a navigation act" —
   *  named here because `openInWindow` used to inline it as an unconditional
   *  `explorer.resetToBaseDir()`, which threw away the tree's expansion state
   *  (all of it, DOM-only SSOT) on every single-window document open,
   *  including a plain click on a row already inside the visible tree
   *  (the 2026-08-25 folder-collapse regression). Three branches, in order:
   *
   *  1. Global vault preserving its explorer root (`shouldPreserveGlobalExplorerRoot`)
   *     — unaffected by this rule; keep the pre-existing behavior exactly
   *     (no reset, breadcrumb tracks `currentExplorerFolder`).
   *  2. `explorer.showsFolderOf(file)` — the tree's current root ALREADY
   *     covers this file's folder (typically: the vault root is locked and
   *     the user just clicked a row inside the visible tree, or the vault
   *     was just selected and `jumpToRoot` already rendered this root in the
   *     same synchronous tick — see main.ts's vault-select commit path).
   *     Leave the tree alone (expansion/scroll/focus all survive for free)
   *     and point the breadcrumb at the tree's actual root, not
   *     `currentBaseDir` (which drifts from the vault root once the open
   *     document sits in a subfolder — the "harmless double render" this
   *     branch also fixes).
   *  3. Anything else (recent list, history, wikilink, or the file-finder
   *     opening a document outside whatever the tree happens to show right
   *     now) — the tree genuinely has nothing to show; fall back to the old
   *     reset-to-the-document's-folder behavior.
   *
   *  `explorer.setActiveFile(file)` runs unconditionally after the branch —
   *  the highlight target changes on every successful open regardless of
   *  whether the tree itself was touched (branch 2/3 rebuild the DOM and
   *  reapply it themselves via `renderTree`'s own reapply point; branch 1's
   *  no-op tree still needs the SSOT (`activePath`) updated so a later
   *  expand reveals the right row). Command (void). */
  function syncExplorerToOpenedDocument(file: string): void {
    if (shouldPreserveGlobalExplorerRoot(selectedWorkspaceVault())) {
      breadcrumb.render(currentExplorerFolder);
    } else if (explorer.showsFolderOf(file)) {
      breadcrumb.render(explorer.currentRootPath() ?? currentBaseDir);
    } else {
      explorer.resetToBaseDir();
      breadcrumb.render(currentBaseDir);
    }
    explorer.setActiveFile(file);
  }

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
    if (targetVault) routedVault = targetVault;
    closeConflict();
    closeOpenViewer(); // opening a document closes any open viewer (design §A rule 1)
    teardownCurrent();
    host.classList.remove("welcome-host");
    currentFile = file;
    currentBaseDir = baseDirForOpenedDocument(file, selectedVault);
    if (selectedVault) vaultTabs.open(selectedVault.vaultId, file, tabScopeForVault(selectedVault));
    const { text, mtime } = fresh;

    current = mountEditor(host, text, currentBaseDir, file, {
      onStatus: (status, detail) => {
        save.set(status, detail);
        if (status === "recovery" && !openRecovery) showDocumentRecovery("save", detail ?? "저장 경로를 사용할 수 없습니다");
      },
      initialMode: modeSetting.get(),
      onCursor: (line, col) => {
        pos.textContent = `Ln ${line}, Col ${col}`;
        saveSessionState();
      },
      baseMtime: mtime,
      autosaveDelay: autosaveDelaySetting.get(),
      conflictPolicy: conflictPolicySetting.get(),
      vimMode: vimModeSetting.get(),
      vault: selectedVault,
      // Outline panel's docChanged listener — re-attaches per mount, so the
      // outline tracks whichever document is currently live.
      extraExtensions: outline.listener,
      // Search-panel replace-hint (v0.9.12/v0.9.13 defects) — replaceHintEntry
      // is defined below (registerHandler block) and shared with
      // search.document's initial ⌘F open; a getter (not a value) so a
      // keybindings rebind is reflected the next time a mode switch resyncs
      // an open panel. Safe forward reference: openInWindow (this call's
      // enclosing function) only ever RUNS after the registerHandler block
      // below has executed at boot.
      findReplaceHint: replaceHintEntry,
    });
    currentIsRemote = isRemoteVault(selectedVault);
    currentOpenVaultId = selectedVault.vaultId;
    syncModeIndicator();

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

    // Re-opening swaps the document without firing docChanged on the new editor,
    // so an open outline panel would show the previous file's headings. Refresh
    // explicitly here (no-op when the panel is closed) so it tracks the swap.
    outline.refresh();
    // Reconcile the explorer tree/breadcrumb/highlight with the newly-opened
    // document — see syncExplorerToOpenedDocument's doc comment for the
    // three-branch rule ("opening a document is not a navigation act").
    syncExplorerToOpenedDocument(file);

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

    // dev-only: expose the live controller so the debug harness can read real
    // editor state (selection offsets, block specs) instead of guessing.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
      (window as unknown as { __mermark?: unknown }).__mermark = current;
  }

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

  /** Step the history cursor by `move` (back/forward) and open the target,
   *  reusing the single open path. A no-op move (already at an end) returns
   *  early. The pointer is only committed AFTER a successful read, so a failed
   *  read leaves the history unchanged — a dead entry is pruned and skipped.
   *  Command (void). Shared body so back and forward differ by one function. */
  async function navigateHistory(move: (h: NavHistory<NavEntry>) => NavHistory<NavEntry>): Promise<void> {
    const next = move(navHistory);
    if (next === navHistory) return; // at an end → no-op (same-ref signal)
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
    let fresh: { text: string; mtime: number };
    try {
      fresh = await fileHostFor(targetVault).readFile(target);
    } catch {
      // The target file is gone: forget it and skip (no navigation).
      navHistory = pruneAt(navHistory, next.index);
      return;
    }
    if (!(await commitBeforeSwitch())) return;
    if (!(await watcherHandoff.handoff(target, targetVault))) return;
    navHistory = next; // commit the pointer only after the read succeeded
    openInWindow(target, fresh, { viaHistory: true }, targetVault);
  }
  const goBack = (): void => void navigateHistory(back);
  const goForward = (): void => void navigateHistory(forward);

  // ── Window-global wiring (installed ONCE; reads `current` so it always
  //    reaches the live editor after a re-mount). ─────────────────────────────

  // The mermaid widget stays markdown-layer-only (no chrome import) and
  // instead dispatches this bubbling CustomEvent on a fullscreen-button click
  // (mermaid-widget.ts's dispatchOpenFullscreen); main is the one listener
  // that turns it into the chrome-layer lightbox — the same "widget emits,
  // chrome listens" boundary `mermaid-rendered` already crosses. One
  // document-level listener covers every mermaid widget across every
  // document — no per-mount (re)registration needed. Independent of
  // openViewer/openWithViewer/breadcrumb (file-viewer state above): a
  // diagram is only clickable while the editor itself is visible, so it can
  // never open while a file viewer already occupies the content area.
  document.addEventListener("mermaid-open-fullscreen", (e) => {
    openMermaidLightbox((e as CustomEvent<{ svgHtml: string }>).detail.svgHtml);
  });

  /** Resolve an external (on-disk) change against the live buffer. The branch
   *  rule lives in decideExternalChange (pure): with no unsaved work the disk
   *  version is adopted silently (reloadFromFile); otherwise the two diverged so
   *  the conflict modal lets the user pick — keep local (forceSave = clobber +
   *  rebaseline) or use external (reloadFromFile). Named so the "auto-reload vs
   *  conflict" decision isn't an inline if at the listener site. Command: void. */
  function resolveExternalChange(text: string, mtime: number): void {
    if (!current) return;
    if (decideExternalChange(current.hasUnsaved()) === "reload") {
      current.reloadFromFile(text, mtime);
      return;
    }
    const editor = current;
    const file = currentFile;
    const identity = currentConflictIdentity();
    if (!identity) return;
    const isLive = (): boolean => current === editor && currentFile === file && sameConflictIdentity(currentConflictIdentity() ?? identity, identity);
    const rejectStaleAction = (): boolean => {
      if (isLive()) return false;
      closeConflict();
      return true;
    };
    conflictRecovery.detect(identity, current.view.state.doc.toString(), text);
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
      (window as unknown as { __mermarkConflictRecovery?: unknown }).__mermarkConflictRecovery = conflictRecovery;
    closeConflict();
    openConflict = openConflictModal({
      local: editor.view.state.doc.toString(),
      external: text,
      onKeepLocal: () => {
        if (rejectStaleAction()) return;
        conflictRecovery.keepMine(identity);
        editor.forceSave();
      },
      onUseExternal: () => {
        if (rejectStaleAction()) return;
        const result = conflictRecovery.applyExternal(identity);
        editor.reloadFromFile(result.resultContent ?? text, mtime);
      },
      onMerge: () => {
        if (rejectStaleAction()) return;
        const result = conflictRecovery.merge(identity);
        editor.reloadFromFile(result.resultContent ?? text, mtime);
        editor.forceSave();
      },
      onDismiss: () => {
        closeConflict();
      },
    });
  }
  // Subscribe ONCE to the backend's external-change event; the callback reads the
  // live `current` cell, so it tracks re-opens without re-subscribing. Self-writes
  // are filtered in the backend (mtime baseline), so this only fires on real
  // external edits. Guarded to Tauri/browser-mock environments that emit events.
  void onFileChanged((change) => {
    if (!watcherHandoff.accepts(change, currentFile)) return;
    resolveExternalChange(change.text, change.mtime);
  });
  void onFileUnavailable((change) => {
    if (!watcherHandoff.accepts(change, currentFile)) return;
    if (!current || !currentFile) return;
    current.suspendWrites(change.detail);
    showDocumentRecovery(change.kind, change.detail);
  });
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
      const saved = await current.saveOnClose();
      if (saved) await win.destroy();
      else {
        current.resumeWrites();
        showDocumentRecovery("save", "닫기 전에 저장하지 못했습니다");
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

  // Auto-restart once an update download finishes (사용자 요청 2026-08-19):
  // update-flow used to just sit in "downloaded" until the user clicked
  // "설치하고 재시작" (footer button or the settings 버전 pane). Lives here, not
  // in update-flow.ts, because update-flow must stay editor-agnostic (its own
  // header comment) — only main.ts knows about `current`/commitBeforeSwitch,
  // and relaunching the process without flushing the live buffer first could
  // drop an edit that never made it to disk. commitBeforeSwitch (not
  // flushSave) is the right tool here: flushSave() is fire-and-forget (void),
  // so we couldn't tell whether the write actually landed before killing the
  // process; commitBeforeSwitch already exists for exactly this "confirm the
  // buffer is durably persisted before doing something disruptive" contract
  // (mtime-conflict rescue via the .mermark-recovered sibling included) and
  // resolves only once settled. If it resolves false (both the original AND
  // the recovery write failed), we do NOT relaunch — commitBeforeSwitch's own
  // failure path already resumed autosave and surfaced a recovery dialog, so
  // the user keeps editing and can retry the update manually later. Never
  // discard unsaved work to force a restart.
  //
  // autoInstallArmed guards against update-flow's own catch-and-revert:
  // installAndRelaunch() reverts phase back to "downloaded" if install() or
  // relaunch() fails (update-flow.ts), and without this guard that revert
  // would re-trigger this same subscriber forever (repeated failing installs
  // in a tight loop). It's re-armed only when a FRESH download starts
  // ("downloading" phase), so a later successful download still auto-
  // installs; after a failed auto-attempt, the phase stays "downloaded" and
  // the existing "설치하고 재시작" buttons remain as the manual fallback
  // (their click handlers call installAndRelaunch() directly, unaffected by
  // this flag).
  let autoInstallArmed = true;
  subscribeUpdate(() => {
    const phase = updatePhase();
    if (phase === "downloading") {
      autoInstallArmed = true;
    } else if (phase === "downloaded" && autoInstallArmed) {
      autoInstallArmed = false;
      void (async () => {
        if (!(await commitBeforeSwitch())) return;
        await installAndRelaunch();
      })();
    }
  });

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
  registerHandler("workspace.toggle", () => workspaceSidebar.button.click());
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
  registerHandler("save.flush", () => current?.flushSave());
  // Mod-Alt-F ("찾아 바꾸기"): switch out of reader mode (see find.ts's
  // enterEditModeForReplace for why that's necessary — v0.9.12 real-app
  // bug), then open the same panel ⌘F uses. Same viewer/no-current guard as
  // search.document below.
  const openReplacePanel = (): void => {
    if (viewerSlot.current() || !current) return;
    enterEditModeForReplace();
    openFindPanel(current.view);
  };
  registerHandler("search.replace", openReplacePanel);
  // The search-panel replace-hint entry (label + activate) — ONE definition
  // shared by search.document's initial ⌘F open (below) and editor.ts's
  // resync-on-mode-switch (mountEditor's findReplaceHint getter, wired
  // above openInWindow) so the two call sites can't drift into different
  // labels/activate behavior. Label reads the LIVE bound chord
  // (effectiveBinding), never a hardcoded "⌥⌘F" string, so a rebind can't
  // leave a stale hint. Pure query.
  function replaceHintEntry(): { chordLabel: string; activate: () => void } {
    return {
      chordLabel: displayChord(effectiveBinding("search.replace") ?? "Mod+Alt+F"),
      activate: openReplacePanel,
    };
  }
  // Mod-F: open the document search/replace panel. No-op while a full-pane
  // viewer (pdf/docx/hwp/…) is showing — the editor isn't on screen, so
  // popping its find panel behind the viewer would be silent confusion (see
  // _workspace/01_architect_design.md 판정3 "뷰어 열림 시"). Mod-Shift-F is
  // unaffected by the viewer — opening a result CLOSES the viewer for free
  // (openInWindow's first line already calls closeOpenViewer()).
  //
  // Reader mode still opens ⌘F, but the panel then has no replace row (see
  // enterEditModeForReplace above) — so it always passes replaceHintEntry().
  // openFindPanel/syncReplaceHint show a "바꾸기 (⌥⌘F)" affordance ONLY when
  // the row is actually missing, and remove it once edit mode supplies the
  // real row, so edit mode never shows a redundant hint.
  registerHandler("search.document", () => {
    if (viewerSlot.current() || !current) return;
    openFindPanel(current.view, replaceHintEntry());
  });
  registerHandler("search.files", () => searchPanel.revealSearch());
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
    // Minor (final review, same class as I3): `bundle_doc` is a LOCAL
    // command — a remote document's `currentFile` is a vault-relative name
    // ("노트.md"), which either fails invisibly on the host's own machine
    // (never reached — the invoke never leaves this process) or, if a
    // same-named local file exists, silently bundles the WRONG document.
    // Refuse visibly instead of invoking it at all.
    if (isRemoteVault(currentVault())) {
      flashStatus(REMOTE_VAULT_LOCAL_LINK_MESSAGE);
      return;
    }
    void copyBundleToClipboard(currentFile).then((copied) => {
      flashStatus(copied ? "✓ 번들 복사됨" : "⚠ 번들 복사 실패");
    });
  });
  // ⌥⌘C: copy the current document's absolute path to the clipboard via the
  // backend IPC command (copyTextToClipboard, the same helper bundle.copy
  // uses). `currentFile` is already the live-file SSOT cell. Graceful no-op
  // when no document is open.
  registerHandler("path.copy", () => {
    if (!currentFile) return;
    void copyTextToClipboard(currentFile).then((ok) =>
      flashStatus(ok ? "✓ 경로 복사됨" : "⚠ 경로 복사 실패"),
    );
  });
  // 이미지 첨부 (`vault:` scheme withdrawal): attachImageToVault owns the
  // whole picker→import→insert→finalize/rollback orchestration — this is
  // only the DI adapter wiring it to the live editor/vault-root/flash
  // surface, mirroring bundle.copy/path.copy's own thin wiring.
  // `currentOwningVaultRoot()` is the SAME function setImageSearchRoot wires
  // for rendering — attach and render share one SSOT rule, never two.
  registerHandler("image.attach", () => {
    void attachImageToVault({
      vaultRoot: currentOwningVaultRoot(),
      view: current?.view ?? null,
      invoke,
      flash: flashStatus,
    });
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
  modeSetting.bind(() => syncModeIndicator()); // initial label + on change
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

  if (!initialFile) {
    host.classList.add("welcome-host");
    host.append(welcomePane);
    await registerCliOpenRouting();
    return;
  }

  // First load: route through `openPathEntry` — the same viewer-vs-document
  // judgment every other entry point uses (see its comment). `initialFile`
  // here is either a CLI-launch argument (`file`, above — any extension, so
  // this was exactly the entry point 사용자 리포트 2026-08-17 found missing
  // the viewer check: a cold `mermark foo.pdf` tried to read the PDF as
  // text) or a session-restored tab path (`restoredTab`, above). A restored
  // tab can never be a viewer file: `vaultTabs.open` — the only thing that
  // ever creates a tab — is called exclusively from `openInWindow` (the
  // document branch), never from `openWithViewer`, so a restored tab is by
  // construction always a document path. Routing both sources through the
  // same check is therefore always correct, not just convenient — a
  // restored tab simply never matches a viewer and falls straight to the
  // document branch below. The document branch reuses `openDocumentSafely`
  // (a read failure means the launch file is gone; it already shows the
  // error in place of the editor via `showOpenRecovery` — the same recovery
  // call this used to make by hand, not a second copy of it).
  await openPathEntry(initialFile, (path, targetVault) => openDocumentSafely(path, undefined, targetVault));
  await registerCliOpenRouting();
}

boot();
