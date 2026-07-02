import { renderSidebarButton } from "../sidebar-toggle";

// ---------------------------------------------------------------------------
// Recent-documents LEFT SIDEBAR chrome — the same shell as the file explorer /
// outline asides: a status-bar button toggling a left-of-editor <aside>. The
// panel lists recently opened documents (basename headline + a faint full
// path); clicking one opens it in the current window through the injected
// onOpenFile (which reuses main's read_file → commitBeforeSwitch →
// openInWindow path).
//
// The left sidebar area is mutually exclusive with the explorer and outline
// (one at a time, VSCode-style): opening fires onOpen so main can close the
// other two. That coordination rule lives in main (closeOtherSidebars), not
// here.
//
// This module is editor-adjacent CHROME, not a decoration: its DOM is a
// sibling of the editor (mounted under .workspace, never inside
// .cm-content/.cm-line), so it makes ZERO block/inline decorations and is
// untouched by the live-preview pipeline and the ⌘± zoom measure guard. The
// list is read from the injected getRecent() (a closure over
// recentDocsSetting), and main calls refresh() from a single
// recentDocsSetting.subscribe — the panel never reads the setting directly
// (SSOT sink).
// ---------------------------------------------------------------------------

/** Stable id linking the toggle button (aria-controls) to the aside it toggles. */
const RECENT_ASIDE_ID = "recent-aside";

export interface RecentPanel {
  /** The button to place in the status bar (toggles the sidebar). */
  readonly button: HTMLButtonElement;
  /** The sidebar shell (hidden until first opened). Append as a sibling of the
   *  editor host under .workspace — never inside the editor content. */
  readonly aside: HTMLElement;
  /** Hide the sidebar. Idempotent — used by the mutual-exclusion coordinator to
   *  close this when another left sidebar opens. Command (void). */
  close(): void;
  /** Re-render the list from getRecent(). A no-op while hidden (cost 0 when
   *  closed), so a recentDocsSetting change is cheap when the panel is shut. */
  refresh(): void;
}

export interface RecentHandlers {
  /** The current recent list, most-recent-first. A closure over the setting so
   *  the panel always reads the live value (SSOT), never a captured snapshot. */
  getRecent(): string[];
  /** Open an absolute path in the current window. Injected so the panel reuses
   *  main's open path (read_file → commitBeforeSwitch → openInWindow). Named
   *  onOpenFile (not onOpen) to keep "open a document" distinct from the
   *  panel-opened notification below. */
  onOpenFile(path: string): void;
  /** Called when this sidebar opens, so main can close the other left
   *  sidebars (mutual exclusion). Optional — omitted in unit tests /
   *  standalone use. Same signature as explorer/outline's onOpen. */
  onOpen?(): void;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** The file name at the end of a path (posix or windows separators). Named so
 *  the "headline is the basename" rule lives in one place, not an inline slice. */
function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(sep + 1) : path;
}

export function createRecentPanel({ getRecent, onOpenFile, onOpen }: RecentHandlers): RecentPanel {
  const button = create("button", "chrome-btn recent-btn") as HTMLButtonElement;
  button.title = "최근 문서 (클릭 시 이 창에서 열기)";

  const aside = create("aside", "recent-aside sidebar-aside");
  aside.id = RECENT_ASIDE_ID;
  aside.hidden = true;
  const header = create("div", "recent-header sidebar-header");
  header.textContent = "최근 문서"; // static: the recent list has no path identity of its own
  const listEl = create("div", "recent-list");
  const empty = create("div", "recent-empty");
  empty.textContent = "최근 문서가 없습니다";
  empty.hidden = true;
  aside.append(header, listEl, empty);

  /** Render the toggle button for the current open/closed state (icon + ARIA).
   *  Called at init and on every open()/close() so they never drift. */
  const renderButton = (): void =>
    renderSidebarButton(button, "최근", !aside.hidden, RECENT_ASIDE_ID);
  renderButton();

  /** Rebuild the list from the live setting. Skips work while hidden — a closed
   *  panel costs nothing when the recent list changes. */
  const refresh = (): void => {
    if (aside.hidden) return;
    const recent = getRecent();
    listEl.replaceChildren();
    empty.hidden = recent.length > 0;
    for (const path of recent) {
      const item = create("button", "recent-item");
      item.dataset.path = path;
      const name = create("span", "recent-name");
      name.textContent = basename(path);
      const dir = create("span", "recent-path");
      dir.textContent = path;
      item.append(name, dir);
      item.title = path;
      listEl.append(item);
    }
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

  // Click an item → open it. mousedown (not click) so it lands before focus
  // shifts, matching outline/footnoteNav. One delegated listener (single path).
  listEl.addEventListener("mousedown", (e) => {
    const item = (e.target as HTMLElement).closest(".recent-item") as HTMLElement | null;
    if (!item?.dataset.path) return;
    e.preventDefault();
    onOpenFile(item.dataset.path);
    close();
  });

  return { button, aside, close, refresh };
}
