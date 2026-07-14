import { icon } from "../../icons";
import { basename } from "../../document/path";
import { redundantPathLabel, truncatedPathLabel } from "../../chrome/path-label";

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
  /** Move `absPath` to `toIndex` (drag release or Alt+↑/↓). Injected so main
   *  stays the single favoriteFoldersSetting writer
   *  (set(reorderFavorite(...))) — this section only emits the intent, same
   *  shape as onJump/onRemove (2026-07-12 design-polish batch ①). */
  onReorder(absPath: string, toIndex: number): void;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

// Pixels of pointer travel before a press is read as a drag rather than a
// click (2026-07-12 design-polish batch ①). Below this, pointerup fires the
// click-era meaning (jump/remove); above it, release commits a reorder.
const DRAG_THRESHOLD_PX = 4;

/** "Insertion index = how many item midpoints sit above the pointer" — the
 *  domain rule for translating a drop position into a list index, named so
 *  the pointermove handler doesn't bury it in an inline loop. Boundary
 *  behavior falls out for free: pointer above every midpoint → 0, pointer
 *  below every midpoint → midYs.length (the caller/reorderFavorite clamps
 *  that to the last valid index). Pure query, exported for unit testing. */
export function pickDropIndex(midYs: number[], pointerY: number): number {
  return midYs.filter((y) => y < pointerY).length;
}

/** Regression fix (code-auditor 04_audit_report.md #1, 2026-07-13): pickDropIndex
 *  and reorderFavorite's `toIndex` speak two DIFFERENT index languages that
 *  happen to agree everywhere except a downward interior drop. pickDropIndex
 *  answers "how many items (dragged one included) are still above the
 *  pointer in the PRE-removal list" — an insert-BEFORE position. reorderFavorite
 *  splices the dragged item OUT first, then inserts at `toIndex` into that
 *  now-shorter POST-removal list — a final-position index. Moving an item
 *  downward past its own old slot means the pre-removal insert-before index
 *  overcounts by exactly one (it counted the dragged item itself as "above
 *  the pointer"), so it must be decremented before reaching reorderFavorite;
 *  moving upward (or dropping in place) needs no correction, since removing
 *  the source doesn't shift anything before the target. Pure query, exported
 *  for unit testing. */
export function dropIndexToFinalIndex(insertBeforeIndex: number, fromIndex: number): number {
  return insertBeforeIndex > fromIndex ? insertBeforeIndex - 1 : insertBeforeIndex;
}

export function createFavoritesSection({
  getFavorites,
  onJump,
  onRemove,
  onReorder,
}: FavoritesHandlers): FavoritesSection {
  const el = create("section", "explorer-favorites");
  el.setAttribute("aria-label", "즐겨찾기");

  const header = create("div", "favorites-header sidebar-header");
  const headerGlyph = create("span", "favorites-header-glyph");
  headerGlyph.append(icon("bookmark"));
  const headerLabel = create("span", "favorites-header-label");
  headerLabel.textContent = "즐겨찾기";
  header.append(headerGlyph, headerLabel);

  const listEl = create("div", "favorites-list");
  const empty = create("div", "favorites-empty");
  empty.textContent = "즐겨찾기한 폴더가 없습니다";
  empty.hidden = true;
  el.append(header, listEl, empty);

  // Pointer-drag reorder state (2026-07-12 design-polish batch ①). Set on
  // pointerdown over an item, cleared on pointerup/pointercancel/refresh.
  // "DRAG = PREVIEW, RELEASE = COMMIT" (same idiom as sidebar/sash.ts): only
  // pointerup ever calls onReorder — pointermove just repositions the drop
  // indicator, so a mid-drag refresh (another view mutating the setting)
  // never races a half-applied commit.
  let dragCandidate: {
    path: string;
    item: HTMLElement;
    startY: number;
    fromIndex: number;
    isRemove: boolean;
  } | null = null;
  let dragging = false;
  let dragOverIndex: number | null = null;

  const clearDropIndicators = (): void => {
    listEl
      .querySelectorAll(".favorites-drop-before, .favorites-drop-after")
      .forEach((el) => el.classList.remove("favorites-drop-before", "favorites-drop-after"));
  };

  /** End a drag WITHOUT committing (used by both pointerup's non-commit path
   *  and pointercancel) — strips the visual drag state only. Command (void). */
  const endDragVisuals = (): void => {
    dragCandidate?.item.classList.remove("favorites-drag-source");
    clearDropIndicators();
    dragging = false;
    dragOverIndex = null;
  };

  /** Rebuild the list from the live setting. Unlike the M4 aside, there's no
   *  hidden-panel gate any more — the section is always mounted and visible
   *  whenever the explorer is open, so refresh() always does real work. */
  const refresh = (): void => {
    // A refresh mid-drag means the underlying list changed out from under us
    // (another view's write) — the DOM nodes the drag was tracking are about
    // to be destroyed, so drop the drag state rather than let it dangle.
    dragCandidate = null;
    dragging = false;
    dragOverIndex = null;
    const favorites = getFavorites();
    listEl.replaceChildren();
    empty.hidden = favorites.length > 0;
    for (const path of favorites) {
      const item = create("button", "favorites-item") as HTMLButtonElement;
      item.type = "button";
      item.dataset.path = path;
      // Name line: a leading folder glyph anchors the row (the same "openable
      // container" signal the explorer tree uses), name beside it; the path
      // label below indents to the name's left edge (CSS padding-left).
      const nameRow = create("span", "favorites-name-row");
      const glyph = create("span", "favorites-glyph");
      glyph.append(icon("folder"));
      const name = create("span", "favorites-name");
      name.textContent = basename(path);
      nameRow.append(glyph, name);
      const remove = create("button", "favorites-remove") as HTMLButtonElement;
      remove.type = "button";
      remove.dataset.remove = "true";
      remove.setAttribute("aria-label", "제거");
      remove.append(icon("x"));
      item.append(nameRow);
      // Left-truncating path label (shared with recent-panel.ts — see
      // chrome/path-label.ts for the rtl+<bdi> DOM/CSS rule this builds).
      // Skipped when the path has no directory component — it would just
      // repeat the name line verbatim (redundantPathLabel).
      if (!redundantPathLabel(path)) item.append(truncatedPathLabel(path));
      item.append(remove);
      item.title = path;
      listEl.append(item);
    }
  };
  refresh();

  // Click-or-drag on an item (single delegated pointer listener, matching the
  // pre-existing "one listener per list" convention recent/outline/this
  // section all use — no per-item handlers). 2026-07-12 design-polish batch
  // ①: this REPLACES the previous mousedown-fires-immediately behavior
  // (mousedown→jump/remove) with a pointer 3-phase read, because jumping on
  // press would make a drag impossible to start. This is a DELIBERATE meaning
  // shift (mousedown → pointerup) scoped to this reorderable list only —
  // recent/outline keep their mousedown-fires-immediately behavior.
  //
  //   pointerdown: record the candidate (path/item/startY/fromIndex/isRemove
  //     — the remove-button check happens HERE, at press, so it reflects
  //     what was actually pressed even if the pointer later drifts off it).
  //   pointermove: past a DRAG_THRESHOLD_PX travel, enter drag mode (dim the
  //     source, compute the drop index via pickDropIndex, show a
  //     before/after indicator). Below threshold: no visual change yet — the
  //     press still reads as a pending click.
  //   pointerup: if dragging, commit via onReorder ONLY if the index actually
  //     moved (RELEASE = COMMIT, matching sash.ts's drag idiom); otherwise
  //     replay the click-era meaning (remove-button check first, else jump).
  //   pointercancel: strip the visual state, commit nothing.
  listEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; // primary (left) button only
    const target = e.target as HTMLElement;
    const item = target.closest(".favorites-item") as HTMLElement | null;
    if (!item?.dataset.path) return;
    e.preventDefault(); // no focus/text-selection jitter, matches prior mousedown intent
    const items = Array.from(listEl.querySelectorAll<HTMLElement>(".favorites-item"));
    dragCandidate = {
      path: item.dataset.path,
      item,
      startY: e.clientY,
      fromIndex: items.indexOf(item),
      isRemove: target.closest(".favorites-remove") !== null,
    };
    listEl.setPointerCapture?.(e.pointerId);
  });

  listEl.addEventListener("pointermove", (e) => {
    if (!dragCandidate) return;
    if (!dragging) {
      if (Math.abs(e.clientY - dragCandidate.startY) <= DRAG_THRESHOLD_PX) return;
      dragging = true;
      dragCandidate.item.classList.add("favorites-drag-source");
    }
    const items = Array.from(listEl.querySelectorAll<HTMLElement>(".favorites-item"));
    const midYs = items.map((it) => {
      const r = it.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const idx = pickDropIndex(midYs, e.clientY);
    clearDropIndicators();
    if (idx >= items.length) items[items.length - 1]?.classList.add("favorites-drop-after");
    else items[idx]?.classList.add("favorites-drop-before");
    dragOverIndex = idx;
  });

  listEl.addEventListener("pointerup", () => {
    if (!dragCandidate) return;
    const { path, isRemove, fromIndex } = dragCandidate;
    const wasDragging = dragging;
    const toIndex = dragOverIndex;
    endDragVisuals();
    dragCandidate = null;
    if (wasDragging) {
      const finalIndex = toIndex === null ? fromIndex : dropIndexToFinalIndex(toIndex, fromIndex);
      if (finalIndex !== fromIndex) {
        onReorder(path, finalIndex);
        return;
      }
      // Net-zero drag (crossed DRAG_THRESHOLD_PX but released back over its
      // own original slot) falls through to the click-era meaning below
      // instead of silently swallowing the release (code-auditor 🟡,
      // 2026-07-13) — same remove-checked-first priority as an ordinary
      // non-dragging click, since "no net move" reads as "the user meant to
      // press this," not "the user meant to reorder."
    }
    if (isRemove) {
      onRemove(path);
      return;
    }
    onJump(path);
  });

  listEl.addEventListener("pointercancel", () => {
    endDragVisuals();
    dragCandidate = null;
  });

  // Keyboard reorder (WCAG 2.1.1 — drag must have a non-pointer equivalent).
  // Alt+↑/↓ on a focused item moves it one slot; the setting's listener
  // notification is synchronous (settings/store.ts), so by the time onReorder
  // returns, refresh() has already rebuilt the list — re-find the item by
  // its (still-live) path and restore focus to it so repeated presses keep
  // working without the user losing their place.
  listEl.addEventListener("keydown", (e) => {
    if (!e.altKey || (e.code !== "ArrowUp" && e.code !== "ArrowDown")) return;
    const target = e.target as HTMLElement;
    const item = target.closest(".favorites-item") as HTMLElement | null;
    if (!item?.dataset.path) return;
    e.preventDefault();
    const items = Array.from(listEl.querySelectorAll<HTMLElement>(".favorites-item"));
    const idx = items.indexOf(item);
    const path = item.dataset.path;
    onReorder(path, idx + (e.code === "ArrowDown" ? 1 : -1));
    const restored = Array.from(listEl.querySelectorAll<HTMLElement>(".favorites-item")).find(
      (el) => el.dataset.path === path,
    );
    restored?.focus();
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
