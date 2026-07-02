import { renderSidebarButton } from "../sidebar-toggle";
import { icon } from "../icons";
import { isFavorite } from "./favorite-folders";

// ---------------------------------------------------------------------------
// Favorites LEFT SIDEBAR chrome — the same shell as explorer/outline/recent:
// a status-bar button toggling a left-of-editor <aside>. Unlike recent (an
// MRU of opened DOCUMENTS), this lists user-CURATED FOLDERS: clicking one
// jumps the explorer's root there (onJump), a header ★ button adds the
// current folder (onAdd), and each item carries an X to remove it (onRemove).
//
// SSOT: this panel NEVER reads or writes favoriteFoldersSetting directly. It
// reads through the injected getFavorites() (a closure over the setting, same
// as recent's getRecent) and only EMITS events (onAdd/onRemove/onJump) — main
// is the single writer (favoriteFoldersSetting.set(pushFavorite/removeFavorite(...)))
// and the single re-render trigger (one favoriteFoldersSetting.subscribe).
//
// Self-close: unlike recent (which closes itself after opening a document,
// since opening never opens another sidebar), favorites does NOT self-close
// on click. onJump → explorer.jumpToRoot → (reveals the explorer shell if
// closed →) explorer's onOpen → closeOtherSidebars("explorer") already closes
// favorites as a side effect of the explorer opening. Closing here too would
// just be a redundant (if harmless) second close call — the single-path
// design keeps "who closes favorites on jump" in ONE place (the explorer's
// open path), not two.
//
// Editor-adjacent CHROME, not a decoration: mounted under .workspace, never
// inside .cm-content/.cm-line — zero block/inline decorations, live-preview
// pipeline and the ⌘± zoom measure guard are both untouched.
// ---------------------------------------------------------------------------

/** Stable id linking the toggle button (aria-controls) to the aside it toggles. */
const FAVORITES_ASIDE_ID = "favorites-aside";

export interface FavoritesPanel {
  /** The button to place in the title bar (toggles the sidebar). */
  readonly button: HTMLButtonElement;
  /** The sidebar shell (hidden until first opened). Append as a sibling of the
   *  editor host under .workspace — never inside the editor content. */
  readonly aside: HTMLElement;
  /** Hide the sidebar. Idempotent — used by the mutual-exclusion coordinator to
   *  close this when another left sidebar opens. Command (void). */
  close(): void;
  /** Re-render the list (and the ★-add button state) from getFavorites(). A
   *  no-op while hidden (cost 0 when closed), so a favoriteFoldersSetting
   *  change is cheap when the panel is shut. */
  refresh(): void;
}

export interface FavoritesHandlers {
  /** The current favorites list, insertion order. A closure over the setting
   *  so the panel always reads the live value (SSOT), never a captured
   *  snapshot. */
  getFavorites(): string[];
  /** The folder the ★-add button targets — "the folder the tree is currently
   *  rooted at" (main's currentRoot view state). A closure so it tracks live. */
  getCurrentFolder(): string;
  /** Jump the explorer's root to this absolute folder path. Injected so the
   *  panel reuses main's explorer.jumpToRoot — no new navigation code. */
  onJump(absPath: string): void;
  /** Add the current folder to favorites. Injected so main is the single
   *  favoriteFoldersSetting writer (set(pushFavorite(...))). */
  onAdd(absPath: string): void;
  /** Remove a folder from favorites. Injected so main is the single
   *  favoriteFoldersSetting writer (set(removeFavorite(...))). */
  onRemove(absPath: string): void;
  /** Called when this sidebar opens, so main can close the other left
   *  sidebars (mutual exclusion). Optional — omitted in unit tests /
   *  standalone use. Same signature as explorer/outline/recent's onOpen. */
  onOpen?(): void;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** The file name at the end of a path (posix or windows separators). Private
 *  twin of recent-panel's identical helper — both are tiny and private, so a
 *  shared export isn't worth the coupling (same duplication the recent-panel
 *  twin already accepted). */
function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(sep + 1) : path;
}

export function createFavoritesPanel({
  getFavorites,
  getCurrentFolder,
  onJump,
  onAdd,
  onRemove,
  onOpen,
}: FavoritesHandlers): FavoritesPanel {
  const button = create("button", "chrome-btn favorites-btn") as HTMLButtonElement;
  button.title = "즐겨찾기 (폴더 클릭 시 이동)";

  const aside = create("aside", "favorites-aside sidebar-aside");
  aside.id = FAVORITES_ASIDE_ID;
  aside.hidden = true;
  const header = create("div", "favorites-header sidebar-header");
  const headerLabel = create("span", "favorites-header-label");
  headerLabel.textContent = "즐겨찾기";
  const addBtn = create("button", "favorites-add") as HTMLButtonElement;
  addBtn.type = "button";
  addBtn.title = "현재 폴더 추가";
  addBtn.append(icon("star"));
  header.append(headerLabel, addBtn);
  const listEl = create("div", "favorites-list");
  const empty = create("div", "favorites-empty");
  empty.textContent = "즐겨찾기한 폴더가 없습니다";
  empty.hidden = true;
  aside.append(header, listEl, empty);

  /** Render the toggle button for the current open/closed state (icon + ARIA).
   *  Called at init and on every open()/close() so they never drift. */
  const renderButton = (): void =>
    renderSidebarButton(button, "star", "즐겨찾기", !aside.hidden, FAVORITES_ASIDE_ID);
  renderButton();

  /** Sync the header ★-add button to whether the current folder is already
   *  favorited — disabled + aria-pressed=true when it is (the "already
   *  pinned" affordance), enabled otherwise. Command (void). */
  const renderAddButton = (): void => {
    const already = isFavorite(getFavorites(), getCurrentFolder());
    addBtn.disabled = already;
    addBtn.setAttribute("aria-pressed", String(already));
  };

  /** Rebuild the list from the live setting. Skips work while hidden — a
   *  closed panel costs nothing when the favorites list changes. */
  const refresh = (): void => {
    if (aside.hidden) return;
    const favorites = getFavorites();
    listEl.replaceChildren();
    empty.hidden = favorites.length > 0;
    for (const path of favorites) {
      const item = create("button", "favorites-item") as HTMLButtonElement;
      item.type = "button";
      item.dataset.path = path;
      const name = create("span", "favorites-name");
      name.textContent = basename(path);
      const dir = create("span", "favorites-path");
      dir.textContent = path;
      const remove = create("button", "favorites-remove") as HTMLButtonElement;
      remove.type = "button";
      remove.dataset.remove = "true";
      remove.setAttribute("aria-label", "제거");
      remove.append(icon("x"));
      item.append(name, dir, remove);
      item.title = path;
      listEl.append(item);
    }
    renderAddButton();
  };

  const open = () => {
    aside.hidden = false;
    onOpen?.();
    renderButton();
    refresh();
  };
  const close = () => {
    aside.hidden = true;
    renderButton();
  };
  button.addEventListener("click", () => {
    if (aside.hidden) open();
    else close();
  });

  addBtn.addEventListener("click", () => onAdd(getCurrentFolder()));

  // Click an item → jump to it (single delegated mousedown listener, matching
  // recent/outline). The remove button is checked FIRST so removing an item
  // never also fires a jump. No self-close (see module header).
  listEl.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest(".favorites-item") as HTMLElement | null;
    if (!item?.dataset.path) return;
    e.preventDefault();
    if (target.closest(".favorites-remove")) {
      onRemove(item.dataset.path);
      return;
    }
    onJump(item.dataset.path);
  });

  return { button, aside, close, refresh };
}
