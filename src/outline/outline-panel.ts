import { EditorView } from "@codemirror/view";
import { icon } from "../icons";
import { jumpTo } from "../markdown/footnote-nav";
import { collectHeadings } from "../markdown/outline";

// ---------------------------------------------------------------------------
// Outline (table of contents) footer chrome — the same shape as path-prompt's
// open-by-path button: a status-bar button that toggles a lazily-rendered
// in-place panel. The panel lists the document's headings as a depth tree;
// clicking one scrolls + places the caret on that heading line via the SHARED
// jumpTo landing (no bespoke dispatch — single landing path, like footnoteNav).
//
// This module is editor-adjacent CHROME, not a decoration: its DOM is a sibling
// of the editor (mounted under #app, never inside .cm-content/.cm-line), so it
// makes ZERO block/inline decorations and is untouched by the live-preview
// pipeline and the ⌘± zoom measure guard. It reads the live editor read-only
// through the injected getView() (which follows re-opens, like main's `current`).
// ---------------------------------------------------------------------------

/** Debounce for re-collecting headings after a doc change. Named constant, not a
 *  setting: this is an internal UX smoothing delay (no user-visible knob), unlike
 *  the autosave delay which is a real preference. Short enough to feel live, long
 *  enough to coalesce a burst of keystrokes into one re-render. */
const OUTLINE_REFRESH_MS = 180;

export interface OutlinePanel {
  /** The button to place in the status bar (toggles the panel). */
  readonly button: HTMLButtonElement;
  /** The outline panel (hidden until first opened). Append as a sibling of the
   *  status bar (under #app) — never inside the editor content. */
  readonly row: HTMLElement;
  /** Re-collect headings and rebuild the list. A no-op while the panel is hidden
   *  (cost 0 when closed). */
  refresh(): void;
  /** A CM extension that re-renders the panel (debounced) on doc changes. Add to
   *  the editor's extension list so the outline tracks edits live. */
  readonly listener: ReturnType<typeof EditorView.updateListener.of>;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

export interface OutlineHandlers {
  /** Reach the live editor view. A closure (not a captured value) so the panel
   *  follows document re-opens — main passes `() => current.view`. */
  getView(): EditorView;
}

export function createOutlinePanel({ getView }: OutlineHandlers): OutlinePanel {
  const button = create("button", "status-btn outline-btn") as HTMLButtonElement;
  button.append(icon("list-tree"));
  const label = create("span", "status-btn-label");
  label.textContent = "목차";
  button.append(label);
  button.title = "문서 목차 (헤딩 클릭 시 이동)";

  const row = create("div", "outline-row");
  row.hidden = true;
  const tree = create("div", "outline-tree");
  const empty = create("div", "outline-empty");
  empty.textContent = "헤딩이 없습니다";
  empty.hidden = true;
  row.append(tree, empty);

  /** Rebuild the heading list from the live document. While the panel is hidden
   *  this returns immediately — closed panels cost nothing on every keystroke. */
  const refresh = (): void => {
    if (row.hidden) return;
    const headings = collectHeadings(getView().state);
    tree.replaceChildren();
    empty.hidden = headings.length > 0;
    for (const h of headings) {
      const item = create("button", `outline-item outline-h${h.level}`);
      item.dataset.pos = String(h.pos);
      item.textContent = h.text;
      item.title = h.text;
      tree.append(item);
    }
  };

  const open = () => {
    row.hidden = false;
    refresh();
  };
  const close = () => {
    row.hidden = true;
  };
  // Toggle the panel on each button click; opening rebuilds the list.
  button.addEventListener("click", () => {
    if (row.hidden) open();
    else close();
  });

  // Click an item → jump to its heading line. mousedown (not click) so it lands
  // before focus shifts, matching footnoteNav. Goes through jumpTo — the single
  // shared landing (center + caret + focus + async re-center) — NOT a raw
  // view.dispatch, so all navigation lands one way.
  tree.addEventListener("mousedown", (e) => {
    const item = (e.target as HTMLElement).closest(".outline-item") as HTMLElement | null;
    if (!item?.dataset.pos) return;
    e.preventDefault();
    jumpTo(getView(), Number(item.dataset.pos));
  });

  // Live update: re-render (debounced) on doc changes only. Selection-only
  // changes don't move headings, so they're ignored (docChanged gate). A closed
  // panel skips work inside refresh, so this stays cheap when unused.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener = EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, OUTLINE_REFRESH_MS);
  });

  return { button, row, refresh, listener };
}
