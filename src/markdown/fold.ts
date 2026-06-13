import { codeFolding, foldGutter, foldKeymap, foldService, syntaxTree } from "@codemirror/language";
import { keymap } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

const HEADING = /^(#{1,6})\s/;

/** Fold a heading down to (but not including) the next heading of the same or a
 *  higher level — like Obsidian's heading fold. */
function headingRange(state: EditorState, lineStart: number) {
  const line = state.doc.lineAt(lineStart);
  const m = HEADING.exec(line.text);
  if (!m) return null;
  const level = m[1].length;
  let end = line.to;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const t = state.doc.line(n);
    const hm = HEADING.exec(t.text);
    if (hm && hm[1].length <= level) break;
    end = t.to;
  }
  return end > line.to ? { from: line.to, to: end } : null;
}

/** Fold a list item's nested children (the indented sub-list under it). */
function listRange(state: EditorState, lineStart: number) {
  const line = state.doc.lineAt(lineStart);
  const tree = syntaxTree(state);
  // find the ListItem that begins on this line
  let item: SyntaxNode | null = null;
  for (let n: SyntaxNode | null = tree.resolveInner(line.from, 1); n; n = n.parent) {
    if (n.name === "ListItem" && state.doc.lineAt(n.from).number === line.number) {
      item = n;
      break;
    }
  }
  if (!item) return null;
  const child = item.getChild("BulletList") ?? item.getChild("OrderedList");
  if (!child) return null;
  return child.to > line.to ? { from: line.to, to: item.to } : null;
}

/** Headings + list items become foldable. CM tries each foldService in turn. */
export const markdownFolding = [
  codeFolding(),
  foldService.of((state, lineStart) => headingRange(state, lineStart)),
  foldService.of((state, lineStart) => listRange(state, lineStart)),
  foldGutter({
    markerDOM(open) {
      const el = document.createElement("span");
      el.className = `cm-fold-marker${open ? "" : " cm-fold-marker-closed"}`;
      el.textContent = open ? "▾" : "▸"; // ▾ / ▸
      el.title = open ? "접기" : "펼치기";
      return el;
    },
  }),
  keymap.of(foldKeymap),
];
