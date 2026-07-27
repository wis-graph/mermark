import { EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";

// ---------------------------------------------------------------------------
// Document-search (Mod-F) — `@codemirror/search`'s built-in panel, verbatim
// (see _workspace/01_architect_design.md 판정1: a from-scratch find/replace UI
// was rejected — no cold-load win, only maintenance cost). Two things this
// file adds on top of the package default:
//
//   1. Korean phrases via `EditorState.phrases` — the state-facet SSOT the
//      panel actually reads (`phrase(view, "Find")` etc, confirmed by
//      grepping node_modules/@codemirror/search/dist/index.js for every
//      `phrase(view, "...")` call — 11 keys total, no more). NOT a `search()`
//      option; phrases are a document-state-level facet, and `search()` has
//      no i18n option of its own.
//   2. `FIND_KEYMAP_WITHOUT_MOD_F` — the package's `searchKeymap` MINUS its
//      `Mod-f` binding. Mod+F ownership belongs to the global shortcut
//      dispatcher (shortcuts/registry.ts's capture-phase window listener,
//      which always runs before any CM keymap) via the `search.document`
//      action — see actions.ts and main.ts's registerHandler. If the
//      package's own Mod-f binding stayed live, rebinding `search.document`
//      in settings would leave the OLD Mod-F still opening the panel (CM
//      keymap) while the NEW chord also worked (dispatcher) — two live paths
//      to the same command, a drift the design explicitly calls out. F3/
//      Mod-G (next match) and Escape (close) are panel-internal chords, kept
//      as-is — they're not app-level actions with their own catalog entry.
// ---------------------------------------------------------------------------

/** Korean phrases for every string `@codemirror/search`'s panel renders
 *  (`SearchPanel` in the package — verified against its literal
 *  `phrase(view, "...")` calls, not guessed). `EditorState.phrases.of(...)`
 *  is the state-facet SSOT the panel's own `phrase()` helper reads — not a
 *  `search()` config option. Read-mode replace-row suppression is NOT
 *  handled here: the panel itself branches on `view.state.readOnly` and
 *  omits the replace field/buttons entirely (confirmed in the same grep), so
 *  editor.ts's existing `EditorState.readOnly.of(mode === "read")` already
 *  gets that behavior for free. */
export const KOREAN_SEARCH_PHRASES: Record<string, string> = {
  Find: "찾기",
  Replace: "바꾸기",
  next: "다음",
  previous: "이전",
  all: "모두",
  "match case": "대소문자 구분",
  "by word": "단어 단위",
  regexp: "정규식",
  replace: "바꾸기",
  "replace all": "모두 바꾸기",
  close: "닫기",
};

/** `searchKeymap` with its `Mod-f` binding removed — every other panel chord
 *  (F3/Mod-G next-match, Escape close, Mod-Shift-L select-selection-matches,
 *  Mod-Alt-G goto-line, Mod-D select-next-occurrence) is kept verbatim. See
 *  the file header for why Mod-f specifically is excluded. */
export const FIND_KEYMAP_WITHOUT_MOD_F = searchKeymap.filter((b) => b.key !== "Mod-f");

/** The document-search extension bundle: the search panel/highlighter
 *  (docked at `top` — the status bar occupies the bottom edge), Korean
 *  phrases, and the Mod-f-less keymap. A plain extension array (like
 *  editor.ts's other always-on pieces), not gated behind a compartment —
 *  find/replace availability doesn't change with edit/read mode; only the
 *  panel's own replace row does (via the package's readOnly branch above). */
export function findExtensions(): Extension[] {
  return [
    search({ top: true }),
    EditorState.phrases.of(KOREAN_SEARCH_PHRASES),
    keymap.of(FIND_KEYMAP_WITHOUT_MOD_F),
  ];
}

/** Open the Mod-F panel programmatically — main.ts's `search.document` handler
 *  call this instead of importing `@codemirror/search` directly, so the
 *  package dependency stays confined to this one file (the same "main
 *  imports the wrapper, not the library" shape sidebar/search/search-panel.ts
 *  uses for the Tauri `invoke` call). Just `openSearchPanel` re-exported
 *  under the app-level name this codebase's action is named after
 *  (`search.document`, not "search"). NOT also re-exported under its
 *  original `openSearchPanel` name — this file's own header warns against
 *  exactly that shape (two live paths to the same command drift apart), so
 *  it doesn't repeat the mistake for its own export. */
export const openFindPanel = openSearchPanel;

