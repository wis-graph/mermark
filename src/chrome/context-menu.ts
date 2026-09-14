// T4 (0.17.1) — a reusable context-menu PRIMITIVE (design §2.1). The
// explorer's uses it first, but it owns nothing explorer-specific: it only
// knows position, items, `role="menu"`/`menuitem`, keyboard navigation
// (arrows/Home/End/Esc), outside-click/scroll dismissal, and — critically —
// returning focus to whatever triggered it when it closes. Every consumer
// (the file-finder results panel, workspace-sidebar's vault list — both
// already have "path row + right-click-shaped action" per the design doc)
// gets this for free instead of re-implementing Esc-closes/focus-return
// slightly differently each time, which is the actual reuse story here (not
// the menu ITEMS, which are 100% consumer-owned).
//
// Singleton by construction: opening a menu while one is already open closes
// the old one first (`closeActiveMenu` below) — there is only ever at most
// one `[role="menu"]` in the document at a time.

export interface ContextMenuItem {
  readonly label: string;
  readonly disabled?: boolean;
  /** Why this item is disabled — shown as the item's `title` so a greyed-out
   *  item still explains itself instead of just looking broken (design's
   *  "조용한 강등 금지" rule, UI half). Ignored when `disabled` is falsy. */
  readonly disabledReason?: string;
  onSelect(): void;
}

export interface OpenContextMenuOptions {
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  /** Focus returns here when the menu closes for ANY reason (Esc, outside
   *  click, an item being chosen, a second menu superseding this one). */
  readonly returnFocusTo: HTMLElement;
}

let activeMenu: { el: HTMLElement; close: () => void } | null = null;

/** Closes whatever menu is currently open, if any — the single entry point
 *  every dismissal path (Esc, outside click, item select, a new
 *  `openContextMenu` call) routes through, so "only one menu at a time" and
 *  "focus always returns" can't be satisfied by one path and missed by
 *  another. Command (void). */
function closeActiveMenu(): void {
  activeMenu?.close();
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** Clamps a proposed top-left corner so the menu's box stays fully inside
 *  the viewport — a menu opened near the right/bottom edge must not render
 *  partially off-screen. Pure query. */
function clampToViewport(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const maxX = Math.max(0, window.innerWidth - width);
  const maxY = Math.max(0, window.innerHeight - height);
  return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
}

/** Opens a context menu at `(x, y)` with `items`, closing any menu already
 *  open first. Command (void) — the returned value is nothing; interaction
 *  happens entirely through `items[].onSelect` and DOM events. */
export function openContextMenu(opts: OpenContextMenuOptions): void {
  closeActiveMenu();

  const { items, returnFocusTo } = opts;
  const menu = create("div", "context-menu");
  menu.setAttribute("role", "menu");
  // Fixed positioning: this menu is appended straight to `document.body`, not
  // nested under whatever scrolls the triggering row — a scroll (which also
  // closes the menu, below) would otherwise drag it along mid-interaction.
  menu.style.position = "fixed";
  menu.style.left = "0px";
  menu.style.top = "0px";

  const itemEls: HTMLElement[] = [];
  for (const item of items) {
    const el = create("div", "context-menu-item");
    el.setAttribute("role", "menuitem");
    el.tabIndex = -1;
    el.textContent = item.label;
    if (item.disabled) {
      el.setAttribute("aria-disabled", "true");
      if (item.disabledReason) el.title = item.disabledReason;
    } else {
      el.addEventListener("click", () => {
        item.onSelect();
        close();
      });
    }
    menu.append(el);
    itemEls.push(el);
  }

  document.body.append(menu);

  // Position after layout so the menu's real box size is known for clamping.
  const rect = menu.getBoundingClientRect();
  const clamped = clampToViewport(opts.x, opts.y, rect.width, rect.height);
  menu.style.left = `${clamped.x}px`;
  menu.style.top = `${clamped.y}px`;

  let focusIndex = 0;
  const focusFirstEnabled = (): void => {
    focusIndex = itemEls.findIndex((_, i) => !items[i]?.disabled);
    if (focusIndex === -1) focusIndex = 0;
    itemEls[focusIndex]?.focus();
  };
  const moveFocus = (delta: number): void => {
    if (itemEls.length === 0) return;
    focusIndex = (focusIndex + delta + itemEls.length) % itemEls.length;
    itemEls[focusIndex]?.focus();
  };

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("mousedown", onOutsideMousedown, true);
    window.removeEventListener("scroll", close, true);
    menu.remove();
    if (activeMenu?.el === menu) activeMenu = null;
    returnFocusTo.focus();
  };

  const onKeydown = (e: KeyboardEvent): void => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        return;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-1);
        return;
      case "Home":
        e.preventDefault();
        focusIndex = 0;
        itemEls[0]?.focus();
        return;
      case "End":
        e.preventDefault();
        focusIndex = itemEls.length - 1;
        itemEls[focusIndex]?.focus();
        return;
      case "Enter":
      case " ": {
        e.preventDefault();
        const item = items[focusIndex];
        if (item && !item.disabled) {
          item.onSelect();
          close();
        }
        return;
      }
    }
  };
  const onOutsideMousedown = (e: MouseEvent): void => {
    if (e.target instanceof Node && menu.contains(e.target)) return;
    close();
  };

  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("mousedown", onOutsideMousedown, true);
  // A scroll anywhere invalidates this menu's fixed position relative to
  // whatever triggered it — closing (rather than repositioning) matches
  // native context-menu behavior and keeps this primitive simple.
  window.addEventListener("scroll", close, true);

  activeMenu = { el: menu, close };
  focusFirstEnabled();
}
