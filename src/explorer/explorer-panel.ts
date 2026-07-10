import { icon } from "../icons";
import { extensionOf, iconNameForEntry } from "./file-icons";
import { normalizePath } from "../path";
import { renderSidebarButton } from "../sidebar-toggle";

/** Stable id linking the toggle button (aria-controls) to the aside it toggles. */
const EXPLORER_ASIDE_ID = "explorer-aside";

// ---------------------------------------------------------------------------
// File explorer LEFT SIDEBAR — an editor-adjacent chrome shell, not a
// decoration. The panel is a LAZY tree rooted at the current document's folder:
// a folder's children are read on CLICK via the injected listDir() (never on
// hover — WCAG 1.4.13), a top `..` entry single-clicks/Enters upward (root
// change), and clicking/Entering a markdown file opens it in the current window
// through the injected onOpenFile().
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
   *  target). Opens the panel first if it's closed (a closed-panel jump means
   *  "show me that folder", not "wait for it to open on its own") — then
   *  rebuilds at `absPath` via the same path as `..`/reopen (cache clear +
   *  renderTree), so onRootChange fires exactly like any other root change.
   *  Command (void). */
  jumpToRoot(absPath: string): void;
  /** Hide the sidebar. Idempotent — used by the mutual-exclusion coordinator to
   *  close this when the other left sidebar opens. Command (void). */
  close(): void;
  /** Re-sync every rendered folder row's star (aria-pressed + fill class) from
   *  the live `isFavorite` closure. Pure DOM refresh, no document/state
   *  mutation — the favoriteFoldersSetting subscribe sink (main.ts) calls
   *  this alongside the favorites section's own refresh(), so both views of
   *  the SAME setting update from one observation point. Command (void). */
  refreshFavoriteStars(): void;
  /** ⌘⇧B's handler (M5 재배선, design 분기3): open the explorer if it's
   *  closed, then scroll the hosted favorites section into view and DELEGATE
   *  keyboard landing to the injected `focusFavorites` (the section's own
   *  `focusFirst` — first item, or the section itself if empty). Named
   *  `reveal` (not `toggle`) because the action id `favorites.toggle` is a
   *  legacy storage key only — this function's NAME must match what it
   *  actually does. Command (void). */
  revealFavorites(): void;
}

export interface ExplorerHandlers {
  /** Read one directory level. Injected so the panel unit-tests with a fake tree
   *  and, in main, is `(p) => invoke<DirEntry[]>("list_dir", { path: p })`. */
  listDir(path: string): Promise<DirEntry[]>;
  /** The current document's directory — the initial tree root. A closure (not a
   *  captured value) so a fresh open reseeds the root, like outline's getView. */
  getBaseDir(): string;
  /** Open an absolute path in the current window. Injected so the panel reuses
   *  main's read_file → commitBeforeSwitch → openInWindow path (no new open code). */
  onOpenFile(absPath: string): void;
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
  /** Is `path` currently a favorite? A closure over favoriteFoldersSetting so
   *  every folder row always renders the live state (SSOT — the same closure
   *  shape as getBaseDir/getFavorites elsewhere). Optional — GATES star
   *  rendering: a folder row only gets a `.explorer-star` when BOTH
   *  `isFavorite` and `onToggleFavorite` are injected (M5 분기5 "핸들러
   *  gating"), so existing callers that omit them keep the pre-M5 DOM shape
   *  exactly (no star, no roving-tabindex-count regression). */
  isFavorite?(path: string): boolean;
  /** Toggle `path`'s favorite membership (star click / Space on a focused
   *  folder). Injected so main stays the single favoriteFoldersSetting
   *  writer (pushFavorite/removeFavorite) — this panel never imports the
   *  favorites domain. Optional, see `isFavorite` gating above. */
  onToggleFavorite?(path: string): void;
  /** An opaque DOM node (the favorites section's `.el`) explorer hosts BELOW
   *  its tree, inside the same `.explorer-aside` (M5 split-pane, design 분기
   *  1). Explorer never imports the favorites domain — it only appends this
   *  node, exactly like listDir/onOpenFile keep it backend-independent.
   *  Optional — omitted in unit tests that don't exercise the slot. */
  favoritesSlot?: HTMLElement;
  /** The favorites section's own keyboard-landing command (its
   *  `focusFirst`): focus the first `.favorites-item`, or the section itself
   *  when the list is empty. Injected alongside `favoritesSlot` so
   *  `revealFavorites` DELEGATES to it instead of re-deriving the same rule
   *  from the opaque slot node — explorer stays domain-blind (it calls the
   *  callback, it doesn't know what "first favorite" means) while the
   *  landing rule itself has exactly one owner (favorites-panel.ts).
   *  Optional — omitted in unit tests that don't exercise the slot. */
  focusFavorites?(): void;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** A markdown file is the only kind the explorer opens — mermark is a markdown
 *  editor, so read_file'ing a binary would render a broken view. Named rule so
 *  the "only open .md" gate lives in one place, not an inline click `if`. Shares
 *  `extensionOf` so extension parsing converges (still .md-only: `.markdown`
 *  keeps its file-text glyph but stays inert — open policy is out of scope). */
function isMarkdownEntry(name: string): boolean {
  return extensionOf(name) === "md";
}

/** Swap a folder node's glyph to match its open state (`folder` ↔ `folder-open`).
 *  Command (void). Called from the SAME command that sets `aria-expanded`
 *  (expandFolder / collapseFolder) so the glyph and the state can't drift. The
 *  icon id comes from the file-icons SSOT (folders ignore the name). */
function renderFolderGlyph(node: HTMLElement, expanded: boolean): void {
  const glyph = node.querySelector(":scope > .explorer-label > .explorer-glyph");
  if (glyph) glyph.replaceChildren(icon(iconNameForEntry("", true, expanded)));
}

/** Sync a folder row's star BUTTON (not the row) to favorited state:
 *  aria-pressed + aria-label + the `.is-favorite` fill class. Command (void).
 *  Called both at row creation (makeEntry) and by refreshFavoriteStars(), so
 *  the two paths can never drift — a single rule for "what a star looks like
 *  when favorited". Takes the star element directly (not the row) so it works
 *  before the row is attached to the tree (makeEntry builds off-DOM). */
function renderFavoriteStar(star: HTMLButtonElement, isFav: boolean): void {
  star.setAttribute("aria-pressed", String(isFav));
  star.setAttribute("aria-label", isFav ? "즐겨찾기 해제" : "즐겨찾기");
  star.classList.toggle("is-favorite", isFav);
}

export function createExplorerPanel({
  listDir,
  getBaseDir,
  onOpenFile,
  onOpen,
  onRootChange,
  isFavorite,
  onToggleFavorite,
  favoritesSlot,
  focusFavorites,
}: ExplorerHandlers): ExplorerPanel {
  const button = create("button", "chrome-btn explorer-btn icon-only") as HTMLButtonElement;
  button.title = "파일 탐색기 (⌘B · 폴더 클릭 펼침 · 파일 클릭/Enter 열기 · .. 상위)";

  const aside = create("aside", "explorer-aside sidebar-aside");
  aside.id = EXPLORER_ASIDE_ID;
  aside.hidden = true;
  const header = create("div", "explorer-header sidebar-header");
  // Static — path display is now the footer breadcrumb's job (single source
  // of truth), so the header never carries the root path (see renderTree).
  header.textContent = "탐색기";

  /** Render the toggle button for the current open/closed state (icon + ARIA).
   *  Called at init and on every open()/close() so they never drift. */
  const renderButton = (): void =>
    renderSidebarButton(button, "folder", "탐색기", !aside.hidden, EXPLORER_ASIDE_ID);
  renderButton();
  const tree = create("div", "explorer-tree");
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "파일 탐색기");
  aside.append(header, tree);
  // M5 split-pane (design 분기1/7): the favorites section is an opaque node
  // hosted BELOW the tree, inside the SAME .explorer-aside — explorer never
  // imports the favorites domain, it only appends what main handed it. Mounted
  // once at creation (not per-open) so a closed→open toggle never re-parents it.
  if (favoritesSlot) aside.append(favoritesSlot);

  // Per-root cache: a folder's children are read once and reused on re-expand
  // (no re-call). Cleared on root change / panel reopen — MVP has no fs-watch
  // invalidation (lazy read-only tree, "look around this doc lightly").
  const childrenCache = new Map<string, DirEntry[]>();

  /** The focus cursor (roving tabindex owner). Distinct from selection: arrows
   *  move this, but only Enter/click activates. Reset on every renderTree. */
  let focused: HTMLElement | null = null;

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

  /** Read `path` once, then serve from cache on every re-read (re-expand of the
   *  same folder never re-calls list_dir). A missing/blocked folder makes
   *  list_dir reject — treat it as empty (silent, not a crash): the user just
   *  sees no children. The empty result is cached so a bad folder isn't retried. */
  const readChildren = async (path: string): Promise<DirEntry[]> => {
    const hit = childrenCache.get(path);
    if (hit) return hit;
    let entries: DirEntry[];
    try {
      entries = await listDir(path);
    } catch {
      entries = [];
    }
    childrenCache.set(path, entries);
    return entries;
  };

  /** Build one entry row. Folders get a chevron twisty + aria-expanded + a lazy
   *  children group; files get a spacer (chevron alignment) and are greyed +
   *  inert when non-markdown. `level` (1-based) drives aria-level + the CSS
   *  indent var, so indentation always matches the announced depth. */
  const makeEntry = (e: DirEntry, level: number): HTMLElement => {
    const kind = e.is_dir ? "explorer-dir" : "explorer-file";
    const item = create("div", `explorer-item ${kind}`);
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(level));
    item.tabIndex = -1;
    item.dataset.path = e.path;
    item.dataset.level = String(level);
    item.style.setProperty("--level", String(level));
    if (e.is_dir) item.setAttribute("aria-expanded", "false");
    if (!e.is_dir && !isMarkdownEntry(e.name)) item.classList.add("is-nonmd");

    const chevron = create("span", e.is_dir ? "explorer-chevron" : "explorer-chevron explorer-chevron-empty");
    if (e.is_dir) chevron.append(icon("chevron-right"));
    const glyph = create("span", "explorer-glyph");
    glyph.append(icon(iconNameForEntry(e.name, e.is_dir, false)));
    const name = create("span", "explorer-name");
    name.textContent = e.name;
    name.title = e.name;
    // The visible clickable ROW (chevron·glyph·name) is its own flex wrapper, kept
    // separate from the children group so a folder's group nests as a vertical
    // block BELOW the label — not as a flex sibling to its RIGHT (the 527faf6 bug).
    const label = create("div", "explorer-label");
    label.append(chevron, glyph, name);
    // Folder-row favorite star (M5 분기5): GATED — only rendered when BOTH
    // isFavorite and onToggleFavorite are injected, so callers that omit them
    // (existing tests, standalone use) keep the exact pre-M5 DOM shape (no
    // star anywhere, roving-tabindex count unchanged). Files and `..` never
    // get one (confirmed UX: only folders are favoritable). tabindex=-1 keeps
    // it OUT of the roving-tabindex race — the tree's "exactly one tabindex=0"
    // invariant only ever counts .explorer-item nodes, never this button.
    if (e.is_dir && isFavorite && onToggleFavorite) {
      const star = create("button", "explorer-star") as HTMLButtonElement;
      star.type = "button";
      star.tabIndex = -1;
      star.append(icon("bookmark"));
      renderFavoriteStar(star, isFavorite(e.path));
      label.append(star);
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
    node.dataset.loaded = "true";
    const path = node.dataset.path;
    if (!path) return;
    const level = Number(node.dataset.level ?? "1") + 1;
    const entries = await readChildren(path);
    for (const child of entries) kids.append(makeEntry(child, level));
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
   *  first visible node without stealing DOM focus. Command (void).
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
   *  stale or pre-normalized value. */
  const renderTree = async (rootPath: string): Promise<void> => {
    rootPath = normalizePath(rootPath);
    onRootChange?.(rootPath);
    tree.replaceChildren();
    focused = null;
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
    const upChevron = create("span", "explorer-chevron explorer-chevron-empty");
    const upGlyph = create("span", "explorer-glyph");
    upGlyph.append(icon("corner-left-up"));
    const upName = create("span", "explorer-name");
    upName.textContent = "..";
    const upLabel = create("div", "explorer-label");
    upLabel.append(upChevron, upGlyph, upName);
    up.append(upLabel);
    up.title = "상위 폴더로 (클릭 / Enter)";
    tree.append(up);

    const entries = await readChildren(rootPath);
    for (const e of entries) tree.append(makeEntry(e, 1));

    const first = visibleItems()[0];
    if (first) focusItem(first, false);
  };

  /** Change the tree root to `parentPath` (the `..` target, still carrying its
   *  lexical `/..` suffix). Clears the per-root cache and rebuilds from scratch
   *  — the previous expansion state belongs to the old root context. Command
   *  (void). `renderTree` (not this function, and not the backend) is what
   *  canonicalizes `parentPath` — that single call is the only normalization
   *  point, so `listDir`/the header/the cache key all end up canonical. */
  const changeRoot = (parentPath: string): void => {
    childrenCache.clear();
    void renderTree(parentPath);
  };

  /** The SINGLE activation path, shared by click + Enter (like mermaid's single
   *  clickEntry): file → open (markdown only; non-md is inert), folder → toggle,
   *  `..` → change root. Selection moves only here (opening a file), never on
   *  arrow navigation. Command (void). */
  const activateItem = (item: HTMLElement): void => {
    if (item.classList.contains("explorer-up")) {
      if (item.dataset.path) changeRoot(item.dataset.path);
      return;
    }
    if (item.classList.contains("explorer-dir")) {
      toggleFolder(item);
      return;
    }
    if (item.classList.contains("is-nonmd")) return; // non-md is greyed + inert
    const path = item.dataset.path;
    if (!path) return;
    selectItem(item);
    onOpenFile(path);
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
  /** Jump the root to `absPath` (the footer breadcrumb's click target): reveal
   *  the shell first if it's closed (a click on a hidden breadcrumb still
   *  means "show me that folder"), then rebuild there. Can't reuse `open()`
   *  directly — `open()` always renders `getBaseDir()`, which would land on
   *  the live document's folder instead of the clicked ancestor — so this
   *  shares only the shell-reveal half via `revealShell`, then calls
   *  `changeRoot` (cache clear + renderTree) like `..` does. Command (void). */
  const jumpToRoot = (absPath: string): void => {
    if (aside.hidden) revealShell();
    changeRoot(absPath);
  };

  /** Re-read isFavorite(path) for every rendered folder row and re-sync its
   *  star. Pure DOM refresh (no renderTree, no cache clear) — cheap enough to
   *  call on every favoriteFoldersSetting change (main.ts's single subscribe
   *  sink), and correct because a folder row keeps its `data-path` for the
   *  lifetime of its DOM (renderTree/expandFolder never mutate it in place).
   *  No-op when isFavorite wasn't injected (nothing to sync). Command (void). */
  const refreshFavoriteStars = (): void => {
    if (!isFavorite) return;
    for (const row of tree.querySelectorAll<HTMLElement>(".explorer-dir")) {
      const star = row.querySelector(":scope > .explorer-label > .explorer-star") as HTMLButtonElement | null;
      if (star && row.dataset.path) renderFavoriteStar(star, isFavorite(row.dataset.path));
    }
  };

  /** ⌘⇧B's handler: reveal the explorer (open it if closed — reusing the
   *  SAME shell-reveal command jumpToRoot uses, so "open" logic lives in one
   *  place), then land the user in the hosted favorites section: scroll it
   *  into view and DELEGATE the "first item, or the section itself" landing
   *  rule to the injected `focusFavorites` (the favorites section's own
   *  `focusFirst`) — explorer never re-derives that rule from the opaque
   *  slot node, so it has exactly one owner (favorites-panel.ts). No-op on
   *  the scroll/focus half if no favoritesSlot/focusFavorites was injected
   *  (standalone/test use). Command (void). */
  const revealFavorites = (): void => {
    if (aside.hidden) open();
    if (!favoritesSlot) return;
    favoritesSlot.scrollIntoView({ block: "nearest" });
    focusFavorites?.();
  };

  button.addEventListener("click", () => {
    if (aside.hidden) open();
    else close();
  });

  /** The folder row's star button containing the click's target, or null if
   *  the click landed outside any star. Named as a finder (not `is*`) because
   *  it returns the element itself, not a boolean — callers truthy-check the
   *  result. Used so the "star pre-empts folder activation" rule is a single
   *  guard checked FIRST in the delegated click listener (favorites-remove
   *  uses the same check-first-then-early-return shape) — not a second
   *  handler bolted onto the row (M5 design 분기5: no per-widget click
   *  handlers). Pure query. */
  const findStarButton = (target: HTMLElement): HTMLElement | null => target.closest(".explorer-star");

  // Click landing — one delegated listener (outline/mermaid single-path shape):
  // clicking an item moves the focus cursor there AND activates it (folder →
  // toggle, file → open, `..` → up). No hover, no dblclick — every action is
  // click- or keyboard-reachable. The star is checked FIRST and early-returns
  // (M5): a star click toggles the favorite and must NEVER also open/collapse
  // the folder underneath it.
  tree.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const star = findStarButton(target);
    if (star) {
      const row = star.closest(".explorer-item") as HTMLElement | null;
      if (row?.dataset.path) onToggleFavorite?.(row.dataset.path);
      return; // early-return: activateItem never runs, the folder doesn't toggle
    }
    const item = target.closest(".explorer-item") as HTMLElement | null;
    if (!item) return;
    focusItem(item);
    activateItem(item);
  });

  /** Space-key rule (WCAG 2.1.1): TOGGLE the FOCUSED folder's favorite
   *  membership (add if absent, remove if present — same as a star click).
   *  Named with the toggle verb (not "star"/"add") because the operation is
   *  a toggle, not an addition. The star button itself is tabindex=-1 (out
   *  of the roving-tabindex race), so keyboard users need a path through the
   *  tree's own keydown — this is it. No-op on files/`..`/when the handler
   *  isn't injected. Command (void). */
  const toggleFocusedFolderFavorite = (item: HTMLElement): void => {
    if (!onToggleFavorite || !item.classList.contains("explorer-dir")) return;
    if (item.dataset.path) onToggleFavorite(item.dataset.path);
  };

  // Keyboard — one delegated keydown on the tree (roving tabindex). Each key maps
  // to a named rule; the tree is a single tab stop and arrows move WITHIN it.
  tree.addEventListener("keydown", (e) => {
    const item = focused;
    if (!item) return;
    // Space is checked via e.code (physical key), matching the shortcuts
    // registry's chord-matching convention, so it fires under non-Latin
    // keyboard layouts too. Space is unused elsewhere in this tree, so this
    // is a pure addition — no existing binding collides.
    if (e.code === "Space") {
      e.preventDefault();
      toggleFocusedFolderFavorite(item);
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
        e.preventDefault();
        activateItem(item);
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

  return { button, aside, resetToBaseDir, jumpToRoot, close, refreshFavoriteStars, revealFavorites };
}
