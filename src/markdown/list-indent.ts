import { acceptCompletion, completionStatus } from "@codemirror/autocomplete";
import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/** Obsidian-style Tab/Shift-Tab list indent. Only intercepts Tab inside a list
 *  item (or a multi-line selection fully inside list items); everywhere else it
 *  falls through to the browser default (focus move) — no global Tab hijack, no
 *  accidental 4-space code-block indentation of plain paragraphs.
 *
 *  Design: `_workspace/01_architect_design.md` ("리스트 Tab/Shift-Tab 들여쓰기"). */

/** True while the wikilink completion popup is open — the rule "an open popup
 *  owns Tab" lives here, once, so no caller re-derives it from completionStatus. */
export function completionPopupIsOpen(state: EditorState): boolean {
  return completionStatus(state) === "active";
}

/** True when `pos`'s line begins (or continues) a list item — resolved via the
 *  syntax tree's ancestor chain, so task items ("- [ ] …") and list items nested
 *  inside a blockquote are covered automatically (they're still ListItem). */
export function lineIsListItem(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(line.from, 1); n; n = n.parent) {
    if (n.name === "ListItem") return true;
  }
  return false;
}

/** True when every non-blank line touched by the selection is a list item — the
 *  gate for multi-line indent/dedent. A selection that mixes list lines with
 *  plain-paragraph lines is NOT a list selection (dedent/indent must pass through
 *  so an ordinary paragraph never gets silently reindented). */
export function selectionOnListLines(state: EditorState): boolean {
  let sawListLine = false;
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n);
      if (line.text.trim() === "") continue; // blank line: skip, don't disqualify
      if (!lineIsListItem(state, line.from)) return false;
      sawListLine = true;
    }
  }
  return sawListLine;
}

/** Tab: popup open → accept the completion (new behavior — completionKeymap
 *  never bound Tab, see design doc §"알려진 트레이드오프"). Else, inside a list
 *  → indentMore. Else → false (pass through, browser default focus move). */
export const indentListItem: Command = (view) => {
  if (completionPopupIsOpen(view.state)) return acceptCompletion(view);
  if (!selectionOnListLines(view.state)) return false;
  return indentMore(view);
};

/** Shift-Tab: inside a list → indentLess. Else → false (pass through). No popup
 *  branch — Shift-Tab has no completion meaning to preserve. */
export const dedentListItem: Command = (view) => {
  if (!selectionOnListLines(view.state)) return false;
  return indentLess(view);
};

export const listIndentKeymap: KeyBinding[] = [
  { key: "Tab", run: indentListItem },
  { key: "Shift-Tab", run: dedentListItem },
];
