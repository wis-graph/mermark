import { icon } from "../../icons";
import { renderEntryGlyph, isEditableTextFile } from "./file-icons";
import { basename, dirOf, isPathWithin, normalizePath } from "../../document/path";
import { renderSidebarButton } from "../toggle";
import { isImeComposing } from "../../shortcuts/keys";

/** Stable id linking the toggle button (aria-controls) to the aside it toggles. */
const EXPLORER_ASIDE_ID = "explorer-aside";

// ---------------------------------------------------------------------------
// File explorer LEFT SIDEBAR — an editor-adjacent chrome shell, not a
// decoration. The panel is a LAZY tree rooted at the current document's folder:
// a folder's children are read on CLICK via the injected listDir() (never on
// hover — WCAG 1.4.13), a top `..` entry single-clicks/Enters upward (root
// change), and clicking/Entering a markdown file opens it in the current window
// through the injected onOpenFile(). ⌘/Ctrl+click or ⌘+Enter on a markdown file
// instead routes to onOpenFileNewWindow() — a brand-new window, the explicit
// new-window gesture (single-window-opening plan). Wikilink clicks do NOT use
// this path — they always open in the current window's safe transaction
// (document-open.ts), with no ⌘/Ctrl new-window variant of their own.
//
// The tree is a WAI-ARIA Tree (APG): role=tree > role=treeitem > role=group,
// roving tabindex (exactly one item is tab-focusable), and a full keyboard set
// (↑↓→←/Enter/Home/End). FOCUS and SELECTION are DISTINCT: arrows move focus
// only; Enter/click activates (opens a file / toggles a folder / changes root).
//
// This module mounts under #app (a sibling of the editor host / status bar),
// never inside .cm-content/.cm-line, so it makes ZERO block/inline decorations
// — the render-smoke invariant ("block decorations come from a StateField") has
// no intersection here, and the ⌘± zoom measure guard is untouched (the aside
// is outside the editor measure tree).
//
// The IPC (`list_dir`) and the file-open path (read_file → commitBeforeSwitch →
// openInWindow) are INJECTED handlers, so this panel unit-tests without a real
// backend and reuses main's open path with zero new open code.
// ---------------------------------------------------------------------------

/** A single directory entry as returned by the backend `list_dir` command.
 *  serde serializes field names verbatim, so `is_dir` stays snake_case here to
 *  mirror the Rust `DirEntry` struct and the browser mock — the 3-way boundary
 *  parity (Rust ↔ this interface ↔ tauri-core mock) is a first-class contract. */
export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface ExplorerPanel {
  /** The button to place in the status bar (toggles the sidebar). */
  readonly button: HTMLButtonElement;
  /** The sidebar shell (hidden until first opened). Append as a sibling of the
   *  editor host under #app / .workspace — never inside the editor content. */
  readonly aside: HTMLElement;
  /** Reset the root to the injected baseDir and rebuild. Call on document switch
   *  so the explorer follows the live document's folder. A no-op while hidden. */
  resetToBaseDir(): void;
  /** Jump the tree root to an arbitrary ancestor (the footer breadcrumb's click
   *  target, or a workspace-sidebar vault selection). Opens the panel first if
   *  it's closed (a closed-panel jump means "show me that folder", not "wait
   *  for it to open on its own") — then rebuilds at `absPath` via the same
   *  path as `..`/reopen (cache clear + renderTree), so onRootChange fires
   *  exactly like any other root change. REVEAL-FOLLOWS-FOCUS: focus follows
   *  into the tree only when this call is the one revealing the panel — an
   *  already-open panel's jump never steals focus from wherever the caller's
   *  gesture actually landed. Command (void). */
  jumpToRoot(absPath: string): void;
  /** Hide the sidebar. Idempotent — used by the mutual-exclusion coordinator to
   *  close this when the other left sidebar opens. Command (void). */
  close(): void;
  /** Re-evaluate every rendered FILE row's `.is-nonmd` gate from the live
   *  `isOpenableEntry` rule (canOpenWithViewer's current answer), without a
   *  renderTree (expansion/scroll/selection all survive). The viewer-toggle
   *  bug this exists to close: `.is-nonmd` is baked in at row-creation time
   *  (makeEntry) and activateItem short-circuits on it BEFORE ever calling
   *  canOpenWithViewer again — so toggling a viewer on/off mid-session left
   *  an already-rendered row either permanently inert (re-enable case) or,
   *  worse, still "openable" after being disabled, which fell through
   *  activateItem's viewer branch (now false) into `onOpenFile` and opened a
   *  non-markdown file AS markdown. This is a pure DOM refresh sink for
   *  a pure DOM refresh sink for a setting the explorer doesn't own, called
   *  from main.ts's disabledViewersSetting.subscribe. Command (void). */
  refreshOpenability(): void;
  /** Re-read the whole tree at the CURRENT root after a listing-POLICY change
   *  (showHiddenFilesSetting): cache clear + renderTree. Contrast
   *  refreshOpenability is a pure DOM refresh,
   *  sufficient when only a rendered ROW's state changes; here the listing
   *  CONTENT itself changes (dotfiles appear/disappear), so every cached
   *  `childrenCache` entry is stale by definition and must be dropped, not
   *  patched. Root is PRESERVED (unlike resetToBaseDir, which jumps back to
   *  the document's folder) — a policy toggle shouldn't discard wherever the
   *  user navigated to. A hidden panel is a no-op (open() rebuilds fresh
   *  anyway, same guard as resetToBaseDir). Command (void). */
  refreshListing(): void;
  /** Re-sync each rendered folder's permanent-vault toggle after workspace state
   *  changes. Filesystem identity is asynchronous; this only updates the
   *  controls and leaves the Explorer root put. */
  refreshVaultToggles(): Promise<void>;
  /** The tree's current root (post-normalization), or `null` before the
   *  first `renderTree` — the SSOT the ⌘⇧F file-finder panel reads instead
   *  of duplicating "which folder is the tree showing" as a second piece of
   *  state (design §루트 SSOT: "탐색기 루트의 정본은 explorer-panel 내부
   *  currentRoot … 상태를 복제하지 않는다"). Pure query. */
  currentRootPath(): string | null;
  /** Does the tree, AS CURRENTLY SHOWN, cover `absPath`'s containing folder —
   *  i.e. is the panel open, has it rendered a root, and does that root sit at
   *  or above that folder? Domain rule this exists to name ("opening a
   *  document is not a navigation act — don't reset the tree if it can
   *  already show the document's folder"): a `false` here is main's signal to
   *  fall back to `resetToBaseDir()`; a `true` means the caller should leave
   *  the tree alone. A closed panel is ALWAYS false — never judged against a
   *  stale `currentRoot` left over from before it closed. Doesn't say whether
   *  that folder is actually EXPANDED right now (the tree's expand/collapse
   *  state is DOM-only and this query doesn't walk it) — only that the root
   *  subtree contains it. Pure query (CQS). */
  showsFolderOf(absPath: string): boolean;
  /** Mark `absPath` as the ACTIVE (currently open) document: highlight its row
   *  (`.is-selected` + `aria-selected`) if the tree has rendered it, clearing
   *  any previous highlight first. `null` clears the highlight entirely (no
   *  document open — welcome pane, discarded document). The SINGLE writer of
   *  the "open file" highlight — `activateItem`'s click/Enter path no longer
   *  marks selection itself, so main.ts is the one place that decides what
   *  "active" means (its `currentFile`). Re-applied automatically after every
   *  `renderTree`/`expandFolder` rebuild, so the mark survives a tree
   *  reconstruction and a lazily-expanded folder that reveals the active row.
   *  Command (void). */
  setActiveFile(absPath: string | null): void;
}

export interface ExplorerHandlers {
  /** Read one directory level. Injected so the panel unit-tests with a fake tree
   *  and, in main, is
   *  `(p) => invoke<DirEntry[]>("list_dir", { path: p, showHidden: … })` — the
   *  panel stays domain-blind (the showHiddenFiles setting lives in the closure,
   *  not here), so this signature carries no toggle knowledge. */
  listDir(path: string): Promise<DirEntry[]>;
  /** The current document's directory — the initial tree root. A closure (not a
   *  captured value) so a fresh open reseeds the root, like outline's getView. */
  getBaseDir(): string;
  /** Open an absolute path in the current window. Injected so the panel reuses
   *  main's read_file → commitBeforeSwitch → openInWindow path (no new open code). */
  onOpenFile(absPath: string): void;
  /** Is a viewer registered for this filename (R11, _workspace/01_r11.md §4)?
   *  Pure query. Optional — GATES non-markdown entries the same way
   *  and `onOpenWithViewer` are injected does a claimed row lose `.is-nonmd`
   *  and become clickable/Enterable (see isOpenableEntry). Callers that omit
   *  it (existing tests, standalone use) keep the pre-R11 behavior exactly —
   *  every non-md row stays greyed + inert. Generalizes the old `onOpenImage`
   *  gate to any registered viewer (image included — it now registers too). */
  canOpenWithViewer?(name: string): boolean;
  /** Open `absPath` in its registered viewer. Optional, paired with
   *  `canOpenWithViewer` (both injected or both omitted — same gating shape).
   *  Lifecycle (don't-stack overlay slot) is the injector's job (main.ts), not
   *  this panel's. Command (void). */
  onOpenWithViewer?(absPath: string): void;
  /** Open a markdown file in a brand-new window (⌘/Ctrl+click, or ⌘+Enter from
   *  the keyboard). Optional — GATED the same way canOpenWithViewer/
   *  onOpenWithViewer gate viewer rows: when omitted, a modifier'd activation
   *  just falls through to onOpenFile (current-window open), so existing
   *  callers keep today's behavior exactly. Markdown-only by design — a
   *  viewer-claimed row is already claimed by onOpenWithViewer before this
   *  branch is reached, so this never fires for it. Injected
   *  so main owns the actual window-spawning call (reuses open_path — the
   *  same command the search panel's own ⌘Enter uses for an explicit
   *  brand-new window). */
  onOpenFileNewWindow?(absPath: string): void;
  /** Called when this sidebar opens, so main can close the other left sidebar
   *  (mutual exclusion). Optional — omitted in unit tests / standalone use. */
  onOpen?(): void;
  /** Called once per renderTree, right after the root is canonicalized — the
   *  SINGLE observation point for "what folder is the tree showing now"
   *  (covers open/changeRoot/resetToBaseDir/jumpToRoot alike, since they all
   *  funnel through renderTree). The footer breadcrumb subscribes here so it
   *  can never drift from the tree it's supposed to describe. Optional —
   *  omitted in unit tests / standalone use. */
  onRootChange?(root: string): void;
  /** Toggle the clicked folder's permanent-vault registration. The main layer
   *  owns canonicalization and persistence; this panel only reports the row's
   *  path. */
  onToggleVault?(root: string): void;
  /** Filesystem-canonical query used to render each folder toggle's current
   *  state. The Promise is required because lexical normalization cannot
   *  resolve symlink/alias identity. */
  isVaultRegistered?(root: string): Promise<boolean>;
  isRootLocked?(): boolean;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** Swap a folder node's glyph to match its open state (`folder` ↔ `folder-open`).
 *  Command (void). Called from the SAME command that sets `aria-expanded`
 *  (expandFolder / collapseFolder) so the glyph and the state can't drift. The
 *  icon id comes from the file-icons SSOT (folders ignore the name). */
function renderFolderGlyph(node: HTMLElement, expanded: boolean): void {
  const glyph = node.querySelector(":scope > .explorer-label > .explorer-glyph");
  if (glyph) renderEntryGlyph(glyph as HTMLElement, "", true, expanded);
}

/** Sync a folder's permanent-vault toggle without changing the tree row. */
function renderVaultToggle(toggle: HTMLButtonElement, registered: boolean): void {
  toggle.replaceChildren(icon(registered ? "bookmark-filled" : "bookmark"));
  toggle.setAttribute("aria-pressed", String(registered));
  toggle.setAttribute("aria-label", registered ? "영구 볼트 해제" : "영구 볼트 등록");
  toggle.title = registered ? "영구 볼트 해제" : "영구 볼트 등록";
  toggle.classList.toggle("is-registered", registered);
}

export function createExplorerPanel({
  listDir,
  getBaseDir,
  onOpenFile,
  canOpenWithViewer,
  onOpenWithViewer,
  onOpenFileNewWindow,
  onOpen,
  onRootChange,
  onToggleVault,
  isVaultRegistered,
  isRootLocked,
}: ExplorerHandlers): ExplorerPanel {
  /** "Does clicking/Entering this row open something?" — isEditableTextFile's
   *  reach extended by the gated viewer case: a non-editable row is only
   *  openable when BOTH canOpenWithViewer/onOpenWithViewer were injected AND
   *  the injected query claims this filename, so callers that omit them keep
   *  every non-editable row
   *  inert exactly as before. Drives BOTH the `.is-nonmd` dim (makeEntry) and
   *  the activation branch (activateItem) from one rule. Pure query. */
  const isOpenableEntry = (name: string): boolean =>
    isEditableTextFile(name) || (!!onOpenWithViewer && !!canOpenWithViewer?.(name));
  const button = create("button", "chrome-btn explorer-btn icon-only") as HTMLButtonElement;
  button.title = "파일 탐색기 (⌘B · 폴더 클릭 펼침 · 파일 클릭/Enter 열기 · ⌘클릭/⌘Enter 새 창 · .. 상위)";

  const aside = create("aside", "explorer-aside sidebar-aside");
  aside.id = EXPLORER_ASIDE_ID;
  aside.hidden = true;
  const header = create("div", "explorer-header sidebar-header");
  // Static — path display is now the footer breadcrumb's job (single source
  // of truth), so the header never carries the root path (see renderTree).
  const headerTitle = create("span");
  headerTitle.textContent = "탐색기";
  const refreshButton = create("button", "explorer-refresh chrome-btn icon-only") as HTMLButtonElement;
  refreshButton.type = "button";
  refreshButton.title = "현재 폴더 새로고침";
  refreshButton.setAttribute("aria-label", "현재 폴더 새로고침");
  refreshButton.append(icon("refresh-cw"));
  header.append(headerTitle, refreshButton);

  /** Render the toggle button for the current open/closed state (icon + ARIA).
   *  Called at init and on every open()/close() so they never drift. */
  const renderButton = (): void =>
    renderSidebarButton(button, "folder", "탐색기", !aside.hidden, EXPLORER_ASIDE_ID);
  renderButton();
  const tree = create("div", "explorer-tree");
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "파일 탐색기");
  // Programmatic-only focus sink (tabIndex -1 never joins the real Tab order —
  // a user can never land here by pressing Tab). REVEAL-FOLLOWS-FOCUS's
  // fallback target when a render that owes focus (see jumpToRoot) lands on a
  // root with nothing focusable inside it (root-locked + empty folder) — so
  // focus has somewhere better than <body> to go even in that edge case,
  // without inventing a real focus trap.
  tree.tabIndex = -1;
  aside.append(header, tree);
  // Per-root cache: a folder's children are read once and reused on re-expand
  // (no re-call). Cleared on root change / panel reopen — MVP has no fs-watch
  // invalidation (lazy read-only tree, "look around this doc lightly").
  const childrenCache = new Map<string, DirEntry[]>();
  const listingErrors = new Map<string, string>();
  const listingRequests = new Map<string, number>();

  /** The tree's current root path (canonical, post-normalization) — set at the
   *  single canonicalization/observation point in renderTree (same spot
   *  onRootChange fires), so it's always what the tree is ACTUALLY showing,
   *  never a stale or pre-normalized value. `refreshListing` reads this to
   *  rebuild in place instead of falling back to getBaseDir(). */
  let currentRoot: string | null = null;
  let renderGeneration = 0;

  /** The currently ACTIVE (open) document's path, or null — the sink half of
   *  `setActiveFile`. Normalized so it compares equal to `dataset.path`
   *  regardless of how the caller spelled the separator. Survives
   *  `renderTree`/`expandFolder` rebuilds (they call `applyActiveHighlight`
   *  after rebuilding); `renderTree`'s own `tree.replaceChildren()` does NOT
   *  reset it — the active file didn't stop being active just because its
   *  row was momentarily removed from the DOM. */
  let activePath: string | null = null;

  const refreshVaultToggles = async (): Promise<void> => {
    if (!isVaultRegistered) return;
    for (const row of tree.querySelectorAll<HTMLElement>(".explorer-dir")) {
      const toggle = row.querySelector<HTMLButtonElement>(":scope > .explorer-label > .explorer-vault-toggle");
      const path = row.dataset.path;
      if (toggle && path) renderVaultToggle(toggle, await isVaultRegistered(path));
    }
  };

  /** The focus cursor (roving tabindex owner). Distinct from selection: arrows
   *  move this, but only Enter/click activates. Reset on every renderTree. */
  let focused: HTMLElement | null = null;

  /** A focus obligation that has NOT yet been paid to the tree. A render can be
   *  superseded (its own generation check below fails) before it ever reaches
   *  the point where it would move focus — main.ts's vault-entry-with-open-
   *  document path does exactly this: jumpToRoot's reveal render is still
   *  awaiting `readChildren` when openInWindow's resetToBaseDir fires a SECOND
   *  render at the same root, in the same synchronous tick. Without this flag,
   *  the discarded render's focus intent is discarded right along with it —
   *  REVEAL-FOLLOWS-FOCUS (see `jumpToRoot`) promises "we just opened a panel
   *  for you, focus goes there", and silently dropping that promise because a
   *  second render happened to win the race makes the rule a lie. Living
   *  outside any one render's closure is the point: whichever render actually
   *  reaches the finish line — not necessarily the one that raised the flag —
   *  is the one that discharges it.
   *
   *  Supersession (`renderGeneration !== renderId`) is the ONLY early exit
   *  allowed to leave this flag standing — it's the only one with a
   *  guaranteed successor (the very render that superseded it) to inherit the
   *  debt. Every other early exit in `renderTree` (a request/error mismatch
   *  at an otherwise-current generation) has no such guarantee, so it must
   *  discharge the flag itself before returning — otherwise a stale
   *  obligation sits armed until some LATER, unrelated render pays it off by
   *  yanking focus into the tree out of nowhere (e.g. mid-keystroke in the
   *  editor), which is worse than the focus loss this flag exists to fix.
   *
   *  No caller reaches that mismatch branch TODAY, which is why it has no
   *  test: `readChildren`'s only callers are `renderTree` — which bumps the
   *  generation and records its own request in one synchronous stretch, so a
   *  loser always fails the generation check first — and `expandFolder`,
   *  which only ever acts on a descendant path, and a descendant can't also
   *  be the root being rendered (the root has no row of its own; `..` is the
   *  parent and everything else is below it). That is a fact about today's
   *  callers, not a guarantee: add a third `readChildren` caller, or split
   *  `renderTree`'s generation bump from its request write, and the branch
   *  goes live. Which is the reason these two conditions stay separate —
   *  folding them back into one `||` reads as a harmless tidy-up and
   *  silently re-arms the stale obligation. */
  let focusOwed = false;

  const allItems = (): HTMLElement[] =>
    [...tree.querySelectorAll(".explorer-item")] as HTMLElement[];

  /** The flattened list of VISIBLE tree items in tree (pre-order) order — every
   *  `.explorer-item` whose ancestor groups are all expanded. Pure query: an
   *  item is hidden iff it sits inside a collapsed `.explorer-children`. This is
   *  the index space the keyboard (↑↓/Home/End) walks. CQS: no side effects. */
  const visibleItems = (): HTMLElement[] =>
    allItems().filter((el) => !el.closest(".explorer-children[hidden]"));

  /** Move the focus cursor to `item`: roving tabindex (this item = 0, all others
   *  = -1) + the `.is-focused` ring. Command (void). `moveDom=false` seeds the
   *  initial cursor on render without stealing DOM focus (no scroll on open). */
  const focusItem = (item: HTMLElement, moveDom = true): void => {
    for (const el of allItems()) {
      el.tabIndex = -1;
      el.classList.remove("is-focused");
    }
    item.tabIndex = 0;
    item.classList.add("is-focused");
    focused = item;
    if (moveDom) item.focus();
  };

  /** Move focus `delta` steps through the visible list (clamped at the ends).
   *  Opens/closes nothing — pure cursor movement (↓ = +1, ↑ = -1). Command. */
  const focusRelative = (delta: number): void => {
    const vis = visibleItems();
    if (!focused) {
      if (vis[0]) focusItem(vis[0]);
      return;
    }
    const i = vis.indexOf(focused);
    const next = vis[Math.min(vis.length - 1, Math.max(0, i + delta))];
    if (next) focusItem(next);
  };

  /** Move focus to the first / last visible node (Home / End). Command (void). */
  const focusEdge = (edge: "first" | "last"): void => {
    const vis = visibleItems();
    const target = edge === "first" ? vis[0] : vis[vis.length - 1];
    if (target) focusItem(target);
  };

  /** Mark `item` as the SELECTED node (single-select): `aria-selected` + the
   *  `.is-selected` fill. Distinct from focus — this only moves when a file is
   *  activated (Enter/click), so arrow navigation never selects. Command. */
  const selectItem = (item: HTMLElement): void => {
    for (const el of allItems()) {
      el.removeAttribute("aria-selected");
      el.classList.remove("is-selected");
    }
    item.setAttribute("aria-selected", "true");
    item.classList.add("is-selected");
  };

  /** Re-derive the `.is-selected` highlight from `activePath` against whatever
   *  rows are CURRENTLY rendered: clear every row's mark, then re-mark the one
   *  whose `dataset.path` matches (if the tree happens to have rendered it —
   *  a collapsed/absent folder just means no row is marked, not an error).
   *  Called after every rebuild (`renderTree`, `expandFolder`) and by
   *  `setActiveFile` itself, so the tree's DOM never drifts from `activePath`
   *  no matter which of the two changed. Command (void). */
  const applyActiveHighlight = (): void => {
    for (const el of allItems()) {
      el.removeAttribute("aria-selected");
      el.classList.remove("is-selected");
    }
    if (!activePath) return;
    const match = allItems().find((el) => el.dataset.path === activePath);
    if (match) selectItem(match);
  };

  /** Set the active document and immediately re-derive the highlight — see the
   *  interface doc comment for the SSOT rule this enforces. Command (void). */
  const setActiveFile = (absPath: string | null): void => {
    activePath = absPath ? normalizePath(absPath) : null;
    applyActiveHighlight();
  };

  /** See the interface doc comment. Pure query (CQS). */
  const showsFolderOf = (absPath: string): boolean =>
    !aside.hidden && currentRoot !== null && isPathWithin(dirOf(absPath), currentRoot);

  const errorMessage = (error: unknown): string =>
    error instanceof Error && error.message.length > 0 ? error.message : "알 수 없는 오류";

  const isValidEntry = (entry: DirEntry): boolean =>
    typeof entry?.name === "string" &&
    typeof entry.path === "string" &&
    typeof entry.is_dir === "boolean";

  /** Read `path` once, then serve successful results from cache on every
   * re-read. Rejections are deliberately never cached as empty arrays. The
   * request number prevents a late result from an older retry from replacing a
   * newer successful result. */
  const readChildren = async (path: string): Promise<{ entries: DirEntry[]; request: number }> => {
    const hit = childrenCache.get(path);
    if (hit) return { entries: hit, request: listingRequests.get(path) ?? 0 };
    const request = (listingRequests.get(path) ?? 0) + 1;
    listingRequests.set(path, request);
    try {
      const entries = await listDir(path);
      if (!Array.isArray(entries) || !entries.every(isValidEntry)) {
        throw new Error("폴더 목록 형식이 올바르지 않습니다");
      }
      if (listingRequests.get(path) === request) {
        childrenCache.set(path, entries);
        listingErrors.delete(path);
      }
      return { entries, request };
    } catch (error) {
      if (listingRequests.get(path) === request) listingErrors.set(path, errorMessage(error));
      throw error;
    }
  };

  const makeState = (className: string, message: string, action?: { className: string; label: string; run: () => void }): HTMLElement => {
    const state = create("div", className);
    const messageNode = create("span", "explorer-state-message");
    messageNode.textContent = message;
    state.append(messageNode);
    if (action) {
      const actionButton = create("button", action.className) as HTMLButtonElement;
      actionButton.type = "button";
      actionButton.textContent = action.label;
      actionButton.addEventListener("click", (event) => {
        event.stopPropagation();
        action.run();
      });
      state.append(actionButton);
    }
    return state;
  };

  const makeEmptyState = (): HTMLElement => makeState("explorer-empty", "이 폴더에는 표시할 파일이 없습니다");

  /** Build one entry row. Folders get a chevron twisty + aria-expanded + a lazy
   *  children group; files get a spacer (chevron alignment) and are greyed +
   *  inert when non-markdown. `level` (1-based) drives aria-level + the CSS
   *  indent var, so indentation always matches the announced depth. */
  const makeEntry = async (e: DirEntry, level: number): Promise<HTMLElement> => {
    const kind = e.is_dir ? "explorer-dir" : "explorer-file";
    const item = create("div", `explorer-item ${kind}`);
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(level));
    item.tabIndex = -1;
    item.dataset.path = e.path;
    item.dataset.level = String(level);
    item.style.setProperty("--level", String(level));
    if (e.is_dir) item.setAttribute("aria-expanded", "false");
    if (!e.is_dir && !isOpenableEntry(e.name)) item.classList.add("is-nonmd");

    const chevron = create("span", e.is_dir ? "explorer-chevron" : "explorer-chevron explorer-chevron-empty");
    if (e.is_dir) chevron.append(icon("chevron-right"));
    const glyph = create("span", "explorer-glyph");
    renderEntryGlyph(glyph, e.name, e.is_dir, false);
    const name = create("span", "explorer-name");
    name.textContent = e.name;
    name.title = e.name;
    // The visible clickable ROW (chevron·glyph·name) is its own flex wrapper, kept
    // separate from the children group so a folder's group nests as a vertical
    // block BELOW the label — not as a flex sibling to its RIGHT (the 527faf6 bug).
    const label = create("div", "explorer-label");
    label.append(chevron, glyph, name);
    if (e.is_dir && onToggleVault && isVaultRegistered) {
      const toggle = create("button", "explorer-vault-toggle");
      toggle.type = "button";
      toggle.tabIndex = -1;
      renderVaultToggle(toggle, await isVaultRegistered(e.path));
      label.append(toggle);
    }
    item.append(label);

    if (e.is_dir) {
      const kids = create("div", "explorer-children");
      kids.setAttribute("role", "group");
      kids.hidden = true;
      item.append(kids);
    }
    return item;
  };

  /** Fill a folder node's children group from list_dir (once) and reveal it.
   *  Command (void). Idempotent via data-loaded — the first click loads, later
   *  ones just re-show the already-built DOM. Children get level+1. */
  const expandFolder = async (node: HTMLElement): Promise<void> => {
    node.setAttribute("aria-expanded", "true");
    renderFolderGlyph(node, true); // glyph swap in the same command as aria-expanded
    const kids = node.querySelector(":scope > .explorer-children") as HTMLElement | null;
    if (!kids) return;
    kids.hidden = false;
    if (node.dataset.loaded === "true") return;
    const path = node.dataset.path;
    if (!path) return;
    const level = Number(node.dataset.level ?? "1") + 1;
    try {
      const result = await readChildren(path);
      if (listingRequests.get(path) !== result.request) return;
      node.dataset.loaded = "true";
      kids.replaceChildren();
      if (result.entries.length === 0) {
        kids.append(makeEmptyState());
        return;
      }
      for (const child of result.entries) kids.append(await makeEntry(child, level));
      // The active document's row may have just been revealed by this expand
      // — re-derive the highlight so it lights up without waiting for a
      // renderTree (setActiveFile's second reapply point, see its doc comment).
      applyActiveHighlight();
    } catch (error) {
      if (listingErrors.get(path) !== errorMessage(error)) return;
      node.removeAttribute("data-loaded");
      kids.replaceChildren(
        makeState("explorer-child-error", `하위 폴더를 읽을 수 없습니다: ${errorMessage(error)}`, {
          className: "explorer-retry",
          label: "다시 시도",
          run: () => retryFolder(node),
        }),
      );
    }
  };

  const retryFolder = (node: HTMLElement): void => {
    const kids = node.querySelector(":scope > .explorer-children") as HTMLElement | null;
    if (!kids) return;
    node.removeAttribute("data-loaded");
    kids.replaceChildren();
    void expandFolder(node);
  };

  /** Hide a folder's children (DOM + cache preserved for instant re-expand).
   *  Command (void). The inverse of expandFolder — the toggle's off half. */
  const collapseFolder = (node: HTMLElement): void => {
    node.setAttribute("aria-expanded", "false");
    renderFolderGlyph(node, false); // glyph swap in the same command as aria-expanded
    const kids = node.querySelector(":scope > .explorer-children") as HTMLElement | null;
    if (kids) kids.hidden = true;
  };

  /** Toggle a folder open/closed. Command (void). The single expand/collapse
   *  decision, shared by click + Enter + → so the rule lives in one place. */
  const toggleFolder = (node: HTMLElement): void => {
    if (node.getAttribute("aria-expanded") === "true") collapseFolder(node);
    else void expandFolder(node);
  };

  /** The folder node that owns `item` (the treeitem wrapping its group), or null
   *  at the root. Pure query — used by ← to walk to the parent. */
  const parentItem = (item: HTMLElement): HTMLElement | null => {
    const group = item.parentElement;
    if (!group?.classList.contains("explorer-children")) return null;
    return group.parentElement as HTMLElement | null;
  };

  /** The first child treeitem of an expanded folder, or null. Pure query — used
   *  by → to step into an already-open folder. */
  const firstChildItem = (node: HTMLElement): HTMLElement | null =>
    node.querySelector(":scope > .explorer-children > .explorer-item") as HTMLElement | null;

  /** (Re)build the tree at `rootPath`: a top `..` entry then the root's sorted
   *  children (level 1). The backend list_dir already sorts (folders first,
   *  name) — we render in the order returned. Seeds the focus cursor on the
   *  first visible node; moves real DOM focus there too iff `focusOnRender`
   *  (REVEAL-FOLLOWS-FOCUS — see `jumpToRoot`), otherwise just seeds the
   *  roving-tabindex cursor without stealing focus (the `open()`/
   *  `resetToBaseDir()` default). Command (void).
   *
   *  This is the SINGLE canonicalization point: `rootPath` is normalized here,
   *  before anything derives from it. `changeRoot`/`open`/`resetToBaseDir`/
   *  `jumpToRoot` all funnel through this one function (the existing "single
   *  update point"), so a `..` navigation can never accumulate literal
   *  `/../../..` in the stored root — each render starts from a canonical
   *  path, appends at most one `..` for the up-entry (see below), and the
   *  NEXT renderTree resolves it away. The same canonicalization point is
   *  also the single observation point: `onRootChange` fires here, right
   *  after normalization, so the footer breadcrumb (or any other observer)
   *  always sees the canonical root the tree is actually showing — never a
   *  stale or pre-normalized value.
   *
   *  `focusOnRender` is honored AFTER `readChildren` resolves below (not at
   *  call time) — `changeRoot`/`jumpToRoot` are void commands that fire this
   *  async function and return immediately, so if we moved focus before the
   *  await, we'd either grab a node that's about to be replaced or grab
   *  nothing at all. Landing the focus move on the far side of the await is
   *  what makes a fast Tab/click right after `jumpToRoot` never race a
   *  still-loading tree.
   *
   *  `focusOnRender` only ever RAISES `focusOwed` (never clears it) — the
   *  render that actually reaches a discharge point below reads and clears
   *  the shared flag, not its own local parameter. That's what lets an
   *  obligation survive being superseded: this call's own generation check
   *  can fail and bail out below without ever un-raising the flag it set, so
   *  the very next render to actually finish (whichever call that is) still
   *  pays it. */
  const renderTree = async (rootPath: string, focusOnRender = false): Promise<void> => {
    rootPath = normalizePath(rootPath);
    const renderId = ++renderGeneration;
    if (focusOnRender) focusOwed = true;
    currentRoot = rootPath;
    onRootChange?.(rootPath);
    tree.replaceChildren();
    focused = null;
    if (!isRootLocked?.()) {
      const up = create("div", "explorer-item explorer-up");
      up.setAttribute("role", "treeitem");
      up.setAttribute("aria-level", "1");
      up.tabIndex = -1;
      up.dataset.level = "1";
      up.style.setProperty("--level", "1");
      // lexical `..` instruction — renderTree canonicalizes before store/display/
      // listDir, so this literal `/..` is a one-shot command ("go up from THIS
      // canonical root"), never a stored value: the very next renderTree call
      // (via changeRoot) resolves it back to canonical, so it can't accumulate.
      up.dataset.path = `${rootPath}/..`;
      // No chevron spacer here (unlike file rows, explorer-panel:299): `..` is a
      // NAVIGATION row, not a tree node — its glyph sits flush left in the
      // chevron column, aligned with the folder chevrons above/below it. A
      // hidden spacer made it the only left-indented row in the tree (2026-07-11
      // design pass).
      const upGlyph = create("span", "explorer-glyph");
      upGlyph.append(icon("corner-left-up"));
      const upName = create("span", "explorer-name");
      upName.textContent = "..";
      const upLabel = create("div", "explorer-label");
      upLabel.append(upGlyph, upName);
      up.append(upLabel);
      up.title = "상위 폴더로 (클릭 / Enter)";
      tree.append(up);
    }

    try {
      const result = await readChildren(rootPath);
      // Superseded by a later render — leave `focusOwed` for it to inherit.
      if (renderGeneration !== renderId) return;
      // Still the current generation, but this particular result is stale for
      // an unrelated reason (see readChildren's request-dedup) — there is no
      // guaranteed later render to inherit the obligation, so it must not
      // survive past this return.
      if (listingRequests.get(rootPath) !== result.request) { focusOwed = false; return; }
      if (result.entries.length === 0) tree.append(makeEmptyState());
      else for (const e of result.entries) tree.append(await makeEntry(e, 1));
      // renderTree's own tree.replaceChildren() (above) wiped any highlight —
      // re-derive it against the freshly-built rows (setActiveFile's first
      // reapply point, see its doc comment).
      applyActiveHighlight();
    } catch (error) {
      if (renderGeneration !== renderId) return; // superseded — same as above
      if (listingErrors.get(rootPath) !== errorMessage(error)) { focusOwed = false; return; } // current generation, stale error — discharge, don't carry forward
      const errorState = makeState("explorer-root-error", `현재 루트를 읽을 수 없습니다: ${errorMessage(error)}`, {
        className: "explorer-root-reselect",
        label: "루트 다시 선택",
        run: () => changeRoot(getBaseDir()),
      });
      tree.append(errorState);
      // A render that owes focus still owes it even when it failed — land on
      // the retry button (a real, useful action) instead of leaving focus
      // wherever it was (often nowhere, post-reveal — see jumpToRoot). Reads
      // the shared flag, not this call's own `focusOnRender` — see that
      // parameter's doc comment above for why.
      const owesFocus = focusOwed;
      focusOwed = false;
      if (owesFocus) errorState.querySelector<HTMLButtonElement>(".explorer-root-reselect")?.focus();
      return;
    }

    // Discharge point: whichever call reaches here — its own generation, not
    // necessarily the one that raised `focusOwed` — pays the obligation.
    const owesFocus = focusOwed;
    focusOwed = false;
    const first = visibleItems()[0];
    if (first) focusItem(first, owesFocus);
    // Nothing to focus at all (root-locked + genuinely empty folder, no `..`
    // row either) — still land somewhere better than <body> when this render
    // owes focus, without inventing a real focus trap (tree.tabIndex=-1, see
    // its declaration above, is programmatic-only).
    else if (owesFocus) tree.focus();
  };

  /** Change the tree root to `parentPath` (the `..` target, still carrying its
   *  lexical `/..` suffix). Clears the per-root cache and rebuilds from scratch
   *  — the previous expansion state belongs to the old root context. Command
   *  (void). `renderTree` (not this function, and not the backend) is what
   *  canonicalizes `parentPath` — that single call is the only normalization
   *  point, so `listDir`/the header/the cache key all end up canonical.
   *  `focusOnRender` just forwards to `renderTree` (REVEAL-FOLLOWS-FOCUS —
   *  see `jumpToRoot`); every other caller keeps the `false` default. */
  const changeRoot = (parentPath: string, focusOnRender = false): void => {
    childrenCache.clear();
    void renderTree(parentPath, focusOnRender);
  };

  /** The SINGLE activation path, shared by click + Enter (like mermaid's single
   *  clickEntry): file → open (markdown or a viewer-claimed file; anything else
   *  is inert), folder → toggle, `..` → change root. Selection moves only here
   *  (opening a file), never on arrow navigation. `newWindow` (⌘/Ctrl+click,
   *  ⌘+Enter) redirects a markdown file's open to onOpenFileNewWindow instead
   *  of onOpenFile — checked AFTER the viewer branch, so a viewer-claimed row is
   *  never affected (viewer opens stay v1-scoped to onOpenWithViewer/
   *  current-context regardless of the modifier — R11 design §4 preserves the
   *  pre-existing image-viewer priority verbatim), and gated by the handler
   *  being injected at all, so omitting it keeps a modifier'd click behaving
   *  exactly like a plain one. Command (void). */
  const activateItem = (item: HTMLElement, newWindow = false): void => {
    if (item.classList.contains("explorer-up")) {
      if (isRootLocked?.()) return;
      if (item.dataset.path) changeRoot(item.dataset.path);
      return;
    }
    if (item.classList.contains("explorer-dir")) {
      toggleFolder(item);
      return;
    }
    if (item.classList.contains("is-nonmd")) return; // non-md/unclaimed is greyed + inert
    const path = item.dataset.path;
    if (!path) return;
    // No selectItem() here — the "open file" highlight is owned solely by
    // setActiveFile (see its interface doc comment). A viewer-claimed row
    // (image/PDF/etc.) never becomes "active": opening a viewer doesn't
    // change main's currentFile, so leaving the underlying markdown
    // document's row highlighted is the CORRECT behavior, not a missed mark.
    if (onOpenWithViewer && canOpenWithViewer?.(basename(path))) onOpenWithViewer(path);
    else if (newWindow && onOpenFileNewWindow) onOpenFileNewWindow(path);
    else onOpenFile(path);
  };

  /** → key rule: closed folder = open / open folder = step to first child /
   *  file · `..` = no-op. Named so the ARIA arrow rule isn't an inline if. */
  const arrowExpandOrEnter = (item: HTMLElement): void => {
    if (!item.classList.contains("explorer-dir")) return;
    if (item.getAttribute("aria-expanded") === "true") {
      const first = firstChildItem(item);
      if (first) focusItem(first);
    } else {
      void expandFolder(item);
    }
  };

  /** ← key rule: open folder = close / everything else = focus parent. Named so
   *  the ARIA arrow rule isn't an inline if. Command (void). */
  const arrowCollapseOrParent = (item: HTMLElement): void => {
    if (item.classList.contains("explorer-dir") && item.getAttribute("aria-expanded") === "true") {
      collapseFolder(item);
      return;
    }
    const parent = parentItem(item);
    if (parent) focusItem(parent);
  };

  /** Make the sidebar shell visible: unhide the aside, fire the mutual-exclusion
   *  hook, sync the toggle button. Does NOT touch the tree/cache — callers
   *  decide what to render (open() renders baseDir, jumpToRoot() renders its
   *  target). Named so "reveal the shell" is one rule shared by both open
   *  paths, not two copies of the same three lines. Command (void). */
  const revealShell = (): void => {
    aside.hidden = false;
    onOpen?.();
    renderButton();
  };
  const open = () => {
    revealShell();
    childrenCache.clear(); // reopen = fresh view (no stale invalidation to track)
    void renderTree(getBaseDir());
  };
  const close = () => {
    aside.hidden = true;
    renderButton();
  };
  const resetToBaseDir = (): void => {
    if (aside.hidden) return; // closed panel reseeds on next open
    childrenCache.clear();
    void renderTree(getBaseDir());
  };
  /** Jump the root to `absPath` (the footer breadcrumb's click target, or a
   *  workspace-sidebar vault selection): reveal the shell first if it's
   *  closed (a click on a hidden breadcrumb still means "show me that
   *  folder"), then rebuild there. Can't reuse `open()` directly — `open()`
   *  always renders `getBaseDir()`, which would land on the live document's
   *  folder instead of the clicked ancestor — so this shares only the
   *  shell-reveal half via `revealShell`, then calls `changeRoot` (cache
   *  clear + renderTree) like `..` does. Command (void).
   *
   *  REVEAL-FOLLOWS-FOCUS: DOM focus moves into the tree iff THIS call is the
   *  one that reveals the shell (`aside` was hidden going in). All three
   *  callers (breadcrumb click, and the two workspace-sidebar vault-select
   *  commit paths in main.ts) are user gestures, so "we just opened a panel
   *  for you, focus goes there" is right in every case — but when the panel
   *  was ALREADY open, jumping the root must never steal focus from wherever
   *  the user actually is (a `.workspace-vault-select` button that just
   *  reselected an already-active vault, say) just because the root
   *  happened to change underneath. `reveals` is captured before
   *  `revealShell()` runs (which flips `aside.hidden`), then threaded through
   *  `changeRoot` to `renderTree`, which is the only place that actually
   *  knows a focus target exists (post-fetch) — see its doc comment for why
   *  the move can't happen here, synchronously.
   *
   *  The promise ("we just opened a panel for you, focus goes there") has to
   *  survive this call's OWN render losing a race. main.ts's vault-entry path
   *  that opens a document calls this, then — same synchronous tick, no
   *  await between them — `resetToBaseDir()` fires a second `renderTree` at
   *  the same root. `renderTree`'s generation guard discards this call's
   *  render before it reaches its focus-move code, and without more, the
   *  promise this call made would be discarded right along with it (focus
   *  would fall to `<body>`, or wherever destroying the clicked
   *  `.workspace-vault-select` button — the workspace panel's own re-render
   *  removes it from the DOM — happens to leave it). `focusOwed` (see
   *  `renderTree`) is what prevents that: the obligation lives outside any
   *  one render's closure, so the SECOND render — the one that actually wins
   *  — inherits and pays it, even though it never asked to reveal anything
   *  itself. */
  const jumpToRoot = (absPath: string): void => {
    if (isRootLocked?.() && normalizePath(absPath) !== normalizePath(getBaseDir())) return;
    const reveals = aside.hidden;
    if (reveals) revealShell();
    changeRoot(absPath, reveals);
  };

  /** Re-toggle `.is-nonmd` on every rendered `.explorer-file` row from the
   *  CURRENT `isOpenableEntry` answer — see the interface doc comment for
   *  why this exists. Scoped to `.explorer-file` only (never `.explorer-dir`/
   *  `.explorer-up`, which have no `.is-nonmd` concept). A row's
   *  `dataset.path` is stable for the lifetime of its DOM (renderTree/
   *  expandFolder never mutate it in place — same guarantee
   *  the rendered row relies on, so
   *  `basename` recovers the filename `isOpenableEntry` needs without
   *  re-reading the tree. Command (void). */
  const refreshOpenability = (): void => {
    for (const row of tree.querySelectorAll<HTMLElement>(".explorer-file")) {
      const path = row.dataset.path;
      if (!path) continue;
      row.classList.toggle("is-nonmd", !isOpenableEntry(basename(path)));
    }
  };

  /** Re-read the CURRENT root after a listing-policy change (showHiddenFiles):
   *  cache clear + renderTree. See the interface doc comment for why this
   *  differs from refreshOpenability (content vs. row
   *  state) and from resetToBaseDir (root preserved vs. reset). `aside.hidden`
   *  guard matches resetToBaseDir's — a closed panel has nothing to redraw,
   *  and open() rebuilds fresh from getBaseDir() on its own anyway. Command
   *  (void). */
  const refreshListing = (): void => {
    if (aside.hidden) return;
    childrenCache.clear();
    void renderTree(currentRoot ?? getBaseDir());
  };

  refreshButton.addEventListener("click", () => refreshListing());

  button.addEventListener("click", () => {
    if (aside.hidden) open();
    else close();
  });

  const toggleFocusedVault = (item: HTMLElement): void => {
    if (!onToggleVault || !item.classList.contains("explorer-dir")) return;
    if (item.dataset.path) onToggleVault(item.dataset.path);
  };

  tree.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const retry = target.closest(".explorer-retry");
    if (retry) {
      const row = retry.closest(".explorer-dir") as HTMLElement | null;
      if (row) retryFolder(row);
      return;
    }
    const toggle = target.closest(".explorer-vault-toggle");
    if (toggle) {
      const row = toggle.closest(".explorer-item") as HTMLElement | null;
      if (row?.dataset.path) onToggleVault?.(row.dataset.path);
      return;
    }
    const item = target.closest(".explorer-item") as HTMLElement | null;
    if (!item) return;
    focusItem(item);
    activateItem(item, e.metaKey || e.ctrlKey);
  });

  // Keyboard — one delegated keydown on the tree (roving tabindex). Each key maps
  // to a named rule; the tree is a single tab stop and arrows move WITHIN it.
  tree.addEventListener("keydown", (e) => {
    const item = focused;
    if (!item) return;
    if (e.code === "Space") {
      e.preventDefault();
      toggleFocusedVault(item);
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRelative(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRelative(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        arrowExpandOrEnter(item);
        break;
      case "ArrowLeft":
        e.preventDefault();
        arrowCollapseOrParent(item);
        break;
      case "Enter":
        if (isImeComposing(e)) return; // let the IME confirm; don't also activate
        e.preventDefault();
        activateItem(item, e.metaKey); // ⌘+Enter = open in a new window
        break;
      case "Home":
        e.preventDefault();
        focusEdge("first");
        break;
      case "End":
        e.preventDefault();
        focusEdge("last");
        break;
    }
  });

  return {
    button,
    aside,
    resetToBaseDir,
    jumpToRoot,
    close,
    refreshOpenability,
    refreshListing,
    refreshVaultToggles,
    currentRootPath: () => currentRoot,
    showsFolderOf,
    setActiveFile,
  };
}
