import { icon } from "../icons";

// ---------------------------------------------------------------------------
// Favorites BOTTOM SECTION (M5) — a split-pane section hosted INSIDE the
// explorer's .explorer-aside (below the file tree), not an independent
// left-sidebar view. M4 shipped favorites as a fourth mutually-exclusive
// <aside> (button + open/close + 4-way exclusion); the M5 redesign folds it
// into the explorer's own aside as a permanently-visible <section> so the
// tree and the favorites list are on screen together (confirmed mockup:
// "탐색기 하단 분리 섹션"). See _workspace/01_architect_design.md 분기 1/2.
//
// Hosting: main builds this section and hands its `el` to
// createExplorerPanel({ favoritesSlot }) — explorer appends it below the
// tree and hosts it as an opaque DOM node (the same injection shape as
// listDir/onOpenFile). Explorer never imports this module or the favorites
// domain — it only knows "a slot to append", keeping the domain boundary
// exactly where main.ts's other panel wiring draws it.
//
// SSOT: this section NEVER reads or writes favoriteFoldersSetting directly.
// It reads through the injected getFavorites() (a closure over the setting,
// same as recent's getRecent) and only EMITS events (onJump/onRemove) — main
// is the single writer (favoriteFoldersSetting.set(pushFavorite/
// removeFavorite(...))) and the single re-render trigger (one
// favoriteFoldersSetting.subscribe that also fans out to the explorer's
// folder-row stars — see main.ts).
//
// header ★-ADD REMOVED (M5): adding a favorite is now the polder row star's
// job (explorer-panel.ts's `.explorer-star`, toggled via pushFavorite). The
// section header's star is a decorative glyph only — no getCurrentFolder,
// no onAdd. The tradeoff (the tree ROOT itself has no row to star) is
// accepted per design 분기 2: `..` still exposes the previous root as a
// child row.
//
// X-remove KEPT (M5): the tree star can only toggle a folder that's
// currently VISIBLE in the tree. A favorite reached by jumping elsewhere has
// no row to un-star, so the section's per-item X is the only off-tree
// removal path — unlike the header ★-add, this one has no tree-side
// equivalent, so it stays.
// ---------------------------------------------------------------------------

export interface FavoritesSection {
  /** The section root. Explorer appends this as a sibling BELOW its tree
   *  (never inside .cm-content/.cm-line — zero decorations, ⌘± zoom guard
   *  untouched, same as the tree itself). Not an <aside> — an <aside> nested
   *  inside another <aside> (the explorer's) would double up the landmark;
   *  a <section aria-label> reads correctly as a labelled sub-region. */
  readonly el: HTMLElement;
  /** Re-render the list from getFavorites(). No open/closed gate any more
   *  (the section is always live once mounted) — cheap because the list is
   *  typically small (user curation, not a big MRU). */
  refresh(): void;
  /** Focus the first favorite item, or the section itself when the list is
   *  empty. Injected into explorer as `focusFavorites` (createExplorerPanel)
   *  so `revealFavorites` DELEGATES here instead of re-deriving the same
   *  landing rule from the opaque slot node — this is the single owner of
   *  "where ⌘⇧B lands". Command (void). */
  focusFirst(): void;
}

export interface FavoritesHandlers {
  /** The current favorites list, insertion order. A closure over the setting
   *  so the section always reads the live value (SSOT), never a captured
   *  snapshot. */
  getFavorites(): string[];
  /** Jump the explorer's root to this absolute folder path. Injected so the
   *  section reuses main's explorer.jumpToRoot — no new navigation code. */
  onJump(absPath: string): void;
  /** Remove a folder from favorites. Injected so main is the single
   *  favoriteFoldersSetting writer (set(removeFavorite(...))). */
  onRemove(absPath: string): void;
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

export function createFavoritesSection({
  getFavorites,
  onJump,
  onRemove,
}: FavoritesHandlers): FavoritesSection {
  const el = create("section", "explorer-favorites");
  el.setAttribute("aria-label", "즐겨찾기");

  const header = create("div", "favorites-header sidebar-header");
  const headerGlyph = create("span", "favorites-header-glyph");
  headerGlyph.append(icon("star"));
  const headerLabel = create("span", "favorites-header-label");
  headerLabel.textContent = "즐겨찾기";
  header.append(headerGlyph, headerLabel);

  const listEl = create("div", "favorites-list");
  const empty = create("div", "favorites-empty");
  empty.textContent = "즐겨찾기한 폴더가 없습니다";
  empty.hidden = true;
  el.append(header, listEl, empty);

  /** Rebuild the list from the live setting. Unlike the M4 aside, there's no
   *  hidden-panel gate any more — the section is always mounted and visible
   *  whenever the explorer is open, so refresh() always does real work. */
  const refresh = (): void => {
    const favorites = getFavorites();
    listEl.replaceChildren();
    empty.hidden = favorites.length > 0;
    for (const path of favorites) {
      const item = create("button", "favorites-item") as HTMLButtonElement;
      item.type = "button";
      item.dataset.path = path;
      const name = create("span", "favorites-name");
      name.textContent = basename(path);
      // The path segment goes in a left-truncating span (styles.css: rtl +
      // text-align:left on .favorites-path). The <bdi> isolates the path's
      // own (LTR) directionality from the rtl trick, so the segment order
      // stays normal (…/work/projects) while the CLIP happens on the left —
      // the confirmed UX (rightmost, most-identifying segment stays visible).
      const dir = create("span", "favorites-path");
      const bdi = document.createElement("bdi");
      bdi.textContent = path;
      dir.append(bdi);
      const remove = create("button", "favorites-remove") as HTMLButtonElement;
      remove.type = "button";
      remove.dataset.remove = "true";
      remove.setAttribute("aria-label", "제거");
      remove.append(icon("x"));
      item.append(name, dir, remove);
      item.title = path;
      listEl.append(item);
    }
  };
  refresh();

  // Click an item → jump to it (single delegated mousedown listener, matching
  // recent/outline). The remove button is checked FIRST so removing an item
  // never also fires a jump. No self-close (there's no aside to close any
  // more — the section stays mounted).
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

  const focusFirst = (): void => {
    const first = listEl.querySelector<HTMLElement>(".favorites-item");
    if (first) {
      first.focus();
      return;
    }
    el.tabIndex = -1;
    el.focus();
  };

  return { el, refresh, focusFirst };
}
