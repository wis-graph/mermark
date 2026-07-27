import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { search, searchKeymap, openSearchPanel, closeSearchPanel, searchPanelOpen } from "@codemirror/search";
import { modeSetting } from "../settings/app";

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

/** Leave reader mode before opening the replace panel. The package's own
 *  `SearchPanel` hides its replace row whenever `state.readOnly` is true
 *  (see file header), and mermark DEFAULTS to reader mode (`modeSetting`,
 *  settings/app.ts) — so without this, replace was unreachable from a fresh
 *  boot (v0.9.12 real-app bug: "찾아 바꾸기가 없는데?"). Goes through
 *  `modeSetting` (the SSOT ⌘E also writes) rather than touching the editor's
 *  mode compartment directly, so every mode-driven sink (status-bar label,
 *  readOnly compartment, live-preview conceal) reacts the normal way. No-op
 *  when already in edit mode. Command (void). */
export function enterEditModeForReplace(): void {
  if (modeSetting.get() === "read") modeSetting.set("edit");
}

/** True when the panel — if opened right now — would omit its replace row.
 *  Mirrors the package's own `SearchPanel` branch on `state.readOnly` (see
 *  the file header): a reader-mode document gets no replace field/buttons at
 *  all. Named so "why is the hint showing" is one query, not an inline
 *  `view.state.readOnly` check duplicated at each call site. Pure query. */
function replaceRowHidden(view: EditorView): boolean {
  return view.state.readOnly;
}

/** Add (or drop) the "바꾸기 (⌥⌘F)"-style affordance in the search panel's own
 *  DOM. Reader mode hides the package's real replace row (see
 *  `replaceRowHidden`), so without this a reader-mode Mod-F user has no
 *  visible path to replace at all (v0.9.12 real-app bug). Once the replace
 *  row IS present (edit mode) any stale hint is removed — the panel must
 *  never show both a real replace UI and a hint pointing at it. `chordLabel`
 *  is the caller-supplied *actual* bound chord (never hardcoded here), so a
 *  rebind never leaves a stale label. Command (void), idempotent. */
function syncReplaceHint(view: EditorView, chordLabel: string, activate: () => void): void {
  const panel = view.dom.querySelector<HTMLElement>(".cm-panel.cm-search");
  if (!panel) return;
  const existing = panel.querySelector<HTMLButtonElement>(".cm-search-replace-hint");
  if (!replaceRowHidden(view)) {
    existing?.remove();
    return;
  }
  if (existing) return; // already showing — do not duplicate
  const hint = document.createElement("button");
  hint.type = "button";
  hint.className = "cm-search-replace-hint";
  hint.textContent = `바꾸기 (${chordLabel})`;
  hint.addEventListener("mousedown", (e) => e.preventDefault()); // keep panel focus
  hint.addEventListener("click", (e) => {
    e.preventDefault();
    activate();
  });
  panel.appendChild(hint);
}

/** Open the Mod-F panel programmatically — main.ts's `search.document` and
 *  `search.replace` handlers call this instead of importing
 *  `@codemirror/search` directly, so the package dependency stays confined
 *  to this one file (the same "main imports the wrapper, not the library"
 *  shape sidebar/search/search-panel.ts uses for the Tauri `invoke` call).
 *
 *  `replaceEntry`, when given, syncs the reader-mode replace-hint button
 *  (see `syncReplaceHint`) after the panel opens — `search.document` passes
 *  it (⌘F must show a path to replace even in reader mode); `search.replace`
 *  omits it (it already switched to edit mode itself, so the real replace
 *  row is showing and no hint is needed — see main.ts's openReplacePanel). */
export function openFindPanel(
  view: EditorView,
  replaceEntry?: { chordLabel: string; activate: () => void },
): boolean {
  const opened = openSearchPanel(view);
  if (replaceEntry) syncReplaceHint(view, replaceEntry.chordLabel, replaceEntry.activate);
  return opened;
}

/** Rebuild an ALREADY-OPEN search panel after `view`'s readOnly flag changes
 *  out from under it (mermark's mode toggle reconfigures a Compartment on
 *  the SAME EditorView — editor.ts's `setMode` — it never remounts the
 *  editor). `@codemirror/search`'s own `SearchPanel` bakes whether it draws
 *  a replace row into its CONSTRUCTOR, reading `view.state.readOnly` exactly
 *  once at panel-open time (see file header); its `update()` method only
 *  reacts to search-query effects, never to readOnly changing. So a panel
 *  opened before a mode switch keeps showing the OLD mode's replace-row-or-
 *  not forever (v0.9.13 real-app bug: open ⌘F in reader mode, then ⌘E to
 *  edit — no replace row ever appears). The package's own supported way to
 *  force a fresh `SearchPanel` instance is close-then-reopen (this changes
 *  the `panel` sub-field's identity, which IS what the panel-hosting
 *  machinery diffs on). This does NOT lose the user's typed search term or
 *  case/regexp/word-boundary options — `searchState`'s `query` sub-field is
 *  untouched by a panel close (only `panel` resets to null), and
 *  `openSearchPanel` reseeds the reopened panel from that exact query via
 *  its own `defaultQuery(state, fallback)` call. `replaceEntry` is forwarded
 *  to `openFindPanel` unchanged, so a reopen into reader mode still gets the
 *  "바꾸기 (⌥⌘F)" hint and a reopen into edit mode still gets the real row.
 *  No-op when the panel isn't open — a mode switch with no panel open has
 *  nothing to resync. Command (void). */
export function resyncFindPanelForMode(
  view: EditorView,
  replaceEntry?: { chordLabel: string; activate: () => void },
): void {
  if (!searchPanelOpen(view.state)) return;
  closeSearchPanel(view);
  openFindPanel(view, replaceEntry);
}

