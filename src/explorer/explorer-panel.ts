import { icon } from "../icons";

// ---------------------------------------------------------------------------
// File explorer footer chrome — the same shape as the outline / open-by-path
// buttons: a status-bar button that toggles a lazily-built in-place panel. The
// panel is a LAZY tree rooted at the current document's folder: a folder's
// children are read on hover via the injected listDir() (debounced), a top `..`
// entry double-clicks upward (root change), and clicking a markdown file opens
// it in the current window through the injected onOpenFile().
//
// This module is editor-adjacent CHROME, not a decoration: its DOM is a sibling
// of the status bar (mounted under #app, never inside .cm-content/.cm-line), so
// it makes ZERO block/inline decorations — the render-smoke invariant ("block
// decorations come from a StateField") has no intersection here, and the ⌘±
// zoom measure guard is untouched (the panel is outside the editor measure tree).
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

/** Debounce for reading a folder's children on hover. Named constant, not a
 *  setting: an internal UX smoothing delay (no user-visible knob) that keeps a
 *  fast sweep across the tree from firing a burst of list_dir calls. Short
 *  enough to feel instant, long enough to skip folders you only pass over. */
const EXPLORER_HOVER_MS = 120;

export interface ExplorerPanel {
  /** The button to place in the status bar (toggles the panel). */
  readonly button: HTMLButtonElement;
  /** The explorer panel (hidden until first opened). Append as a sibling of the
   *  status bar (under #app) — never inside the editor content. */
  readonly row: HTMLElement;
  /** Reset the root to the injected baseDir and rebuild. Call on document switch
   *  so the explorer follows the live document's folder. A no-op while hidden. */
  resetToBaseDir(): void;
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
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** A markdown file is the only kind the explorer opens — mermark is a markdown
 *  editor, so read_file'ing a binary would render a broken view. Named rule so
 *  the "only open .md" gate lives in one place, not an inline click `if`. */
function isMarkdownEntry(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

export function createExplorerPanel({
  listDir,
  getBaseDir,
  onOpenFile,
}: ExplorerHandlers): ExplorerPanel {
  const button = create("button", "status-btn explorer-btn") as HTMLButtonElement;
  button.append(icon("folder"));
  const label = create("span", "status-btn-label");
  label.textContent = "탐색기";
  button.append(label);
  button.title = "파일 탐색기 (폴더 hover 펼침 · 파일 클릭 열기 · .. 더블클릭 상향)";

  const row = create("div", "explorer-row");
  row.hidden = true;
  const tree = create("div", "explorer-tree");
  row.append(tree);

  // Per-root cache: a folder's children are read once and reused on re-hover
  // (no re-call). Cleared on root change / panel reopen — MVP has no fs-watch
  // invalidation (lazy read-only tree, "look around this doc lightly").
  const childrenCache = new Map<string, DirEntry[]>();

  /** Build one entry row. Folders get an aria-expanded toggle + a lazy children
   *  container; files get a click-to-open handle (greyed + no-op when non-md). */
  const makeEntry = (e: DirEntry): HTMLElement => {
    const kind = e.is_dir ? "explorer-dir" : "explorer-file";
    const item = create("div", `explorer-item ${kind}`);
    item.dataset.path = e.path;
    if (e.is_dir) item.setAttribute("aria-expanded", "false");
    if (!e.is_dir && !isMarkdownEntry(e.name)) item.classList.add("is-nonmd");
    const glyph = create("span", "explorer-glyph");
    glyph.append(icon(e.is_dir ? "folder" : "file"));
    const name = create("span", "explorer-name");
    name.textContent = e.name;
    name.title = e.name;
    item.append(glyph, name);
    if (e.is_dir) {
      const kids = create("div", "explorer-children");
      kids.hidden = true;
      item.append(kids);
    }
    return item;
  };

  /** Read `path` once, then serve from cache on every re-read (re-hover / re-open
   *  of the same folder never re-calls list_dir). A missing/blocked folder makes
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

  /** Fill a folder node's children container from list_dir (once) and reveal it.
   *  Command (void). Idempotent via data-loaded — the first hover/click loads,
   *  later ones just re-show the already-built DOM. */
  const expandFolder = async (node: HTMLElement): Promise<void> => {
    node.setAttribute("aria-expanded", "true");
    const kids = node.querySelector(":scope > .explorer-children") as HTMLElement | null;
    if (!kids) return;
    kids.hidden = false;
    if (node.dataset.loaded === "true") return;
    node.dataset.loaded = "true";
    const path = node.dataset.path;
    if (!path) return;
    const entries = await readChildren(path);
    for (const child of entries) kids.append(makeEntry(child));
  };

  /** Hide a folder's children (DOM + cache preserved for instant re-expand).
   *  Command (void). The inverse of expandFolder — the click toggle's off half. */
  const collapseFolder = (node: HTMLElement): void => {
    node.setAttribute("aria-expanded", "false");
    const kids = node.querySelector(":scope > .explorer-children") as HTMLElement | null;
    if (kids) kids.hidden = true;
  };

  /** (Re)build the tree at `rootPath`: a top `..` entry then the root's sorted
   *  children. The backend list_dir already sorts (folders first, name) — we
   *  render in the order returned. Command (void). */
  const renderTree = async (rootPath: string): Promise<void> => {
    tree.replaceChildren();
    const up = create("div", "explorer-item explorer-up");
    up.dataset.path = `${rootPath}/..`; // parent resolution is the backend's job
    const upGlyph = create("span", "explorer-glyph");
    upGlyph.append(icon("corner-left-up"));
    const upName = create("span", "explorer-name");
    upName.textContent = "..";
    up.append(upGlyph, upName);
    up.title = "상위 폴더로 (더블클릭)";
    tree.append(up);
    const entries = await readChildren(rootPath);
    for (const e of entries) tree.append(makeEntry(e));
  };

  /** Change the tree root to `parentPath` (the `..` target). Clears the per-root
   *  cache and rebuilds from scratch — the previous expansion state belongs to
   *  the old root context. Command (void). The parent string is resolved by the
   *  backend (`${root}/..` → normalized), so root-change is a single source. */
  const changeRoot = (parentPath: string): void => {
    childrenCache.clear();
    void renderTree(parentPath);
  };

  const open = () => {
    row.hidden = false;
    childrenCache.clear(); // reopen = fresh view (no stale invalidation to track)
    void renderTree(getBaseDir());
  };
  const close = () => {
    row.hidden = true;
  };
  const resetToBaseDir = (): void => {
    if (row.hidden) return; // closed panel reseeds on next open
    childrenCache.clear();
    void renderTree(getBaseDir());
  };

  button.addEventListener("click", () => {
    if (row.hidden) open();
    else close();
  });

  // Hover a folder → lazily load + expand its children (debounced across a sweep).
  // The first hover triggers the read; the cache makes re-hover free.
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  tree.addEventListener(
    "mouseenter",
    (e) => {
      const node = (e.target as HTMLElement).closest?.(".explorer-dir") as HTMLElement | null;
      if (!node) return;
      if (node.dataset.loaded === "true") return; // already loaded — nothing to fetch
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => void expandFolder(node), EXPLORER_HOVER_MS);
    },
    true, // capture: mouseenter doesn't bubble, so listen on the capturing phase
  );

  // Click landing — one delegated listener, `closest` dispatch (outline pattern):
  //   folder → toggle expand/collapse   file(.md) → open in current window
  //   file(non-md) → no-op (greyed)     `..` → click is inert (dblclick goes up)
  tree.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest(".explorer-item") as HTMLElement | null;
    if (!item) return;
    if (item.classList.contains("explorer-up")) return; // up is dblclick-only
    if (item.classList.contains("explorer-dir")) {
      if (item.getAttribute("aria-expanded") === "true") collapseFolder(item);
      else void expandFolder(item);
      return;
    }
    // A file: open only markdown (non-md is greyed + inert).
    if (item.classList.contains("is-nonmd")) return;
    const path = item.dataset.path;
    if (path) onOpenFile(path);
  });

  // `..` double-click → go up a level (parent becomes the new root, tree reset).
  tree.addEventListener("dblclick", (e) => {
    const up = (e.target as HTMLElement).closest(".explorer-up") as HTMLElement | null;
    if (!up?.dataset.path) return;
    e.preventDefault();
    changeRoot(up.dataset.path);
  });

  return { button, row, resetToBaseDir };
}
