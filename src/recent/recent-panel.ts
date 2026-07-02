import { icon } from "../icons";

// ---------------------------------------------------------------------------
// Recent-documents panel — the same footer-chrome shape as the outline panel: a
// status-bar button toggling a lazily-rendered fixed popover. Each row is a
// recently opened document (basename headline + a faint full path); clicking one
// opens it in the current window through the injected onOpen (which reuses main's
// read_file → commitBeforeSwitch → openInWindow path).
//
// This is editor-adjacent CHROME, not a decoration: its DOM is a sibling of the
// editor (under #app, never inside .cm-content/.cm-line), so it makes ZERO
// block/inline decorations and the ⌘± zoom measure guard is untouched. The list
// is read from the injected getRecent() (a closure over recentDocsSetting), and
// main calls refresh() from a single recentDocsSetting.subscribe — the panel
// never reads the setting directly (SSOT sink).
// ---------------------------------------------------------------------------

export interface RecentPanel {
  /** The button to place in the status bar (toggles the panel). */
  readonly button: HTMLButtonElement;
  /** The panel popover (hidden until first opened). Append as a sibling of the
   *  status bar under #app — never inside the editor content. */
  readonly row: HTMLElement;
  /** Re-render the list from getRecent(). A no-op while hidden (cost 0 when
   *  closed), so a recentDocsSetting change is cheap when the panel is shut. */
  refresh(): void;
}

export interface RecentHandlers {
  /** The current recent list, most-recent-first. A closure over the setting so
   *  the panel always reads the live value (SSOT), never a captured snapshot. */
  getRecent(): string[];
  /** Open an absolute path in the current window. Injected so the panel reuses
   *  main's open path (read_file → commitBeforeSwitch → openInWindow). */
  onOpen(path: string): void;
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

export function createRecentPanel({ getRecent, onOpen }: RecentHandlers): RecentPanel {
  const button = create("button", "status-btn recent-btn") as HTMLButtonElement;
  button.append(icon("history"));
  const label = create("span", "status-btn-label");
  label.textContent = "최근";
  button.append(label);
  button.title = "최근 문서 (클릭 시 이 창에서 열기)";

  const row = create("div", "recent-row");
  row.hidden = true;
  const listEl = create("div", "recent-list");
  const empty = create("div", "recent-empty");
  empty.textContent = "최근 문서가 없습니다";
  empty.hidden = true;
  row.append(listEl, empty);

  /** Rebuild the list from the live setting. Skips work while hidden — a closed
   *  panel costs nothing when the recent list changes. */
  const refresh = (): void => {
    if (row.hidden) return;
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
    row.hidden = false;
    refresh();
  };
  const close = () => {
    row.hidden = true;
  };
  button.addEventListener("click", () => {
    if (row.hidden) open();
    else close();
  });

  // Click an item → open it. mousedown (not click) so it lands before focus
  // shifts, matching outline/footnoteNav. One delegated listener (single path).
  listEl.addEventListener("mousedown", (e) => {
    const item = (e.target as HTMLElement).closest(".recent-item") as HTMLElement | null;
    if (!item?.dataset.path) return;
    e.preventDefault();
    onOpen(item.dataset.path);
    close();
  });

  return { button, row, refresh };
}
