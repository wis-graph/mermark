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

/** A single chevron SVG. open vs closed never swaps the glyph — the same SVG is
 *  rotated 90° by CSS (`.cm-fold-marker-closed svg`), giving a smooth transition.
 *  The chevron points down (open); rotated it points right (closed). `currentColor`
 *  inherits the gutter's color/opacity transitions; `pointer-events:none` keeps
 *  clicks on the <span> so CM's foldGutter toggle still fires. */
const CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
  ' style="pointer-events:none"><path d="M6 9l6 6 6-6"/></svg>';

/** Build the fold-gutter marker: a chevron SVG inside the fold-marker span.
 *  `open`/closed toggles ONLY the `cm-fold-marker-closed` class (CSS rotates the
 *  same SVG) — no glyph swap. Exported so a unit test can assert the SVG exists
 *  and no text glyph leaks back in. */
export function foldMarkerDOM(open: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = `cm-fold-marker${open ? "" : " cm-fold-marker-closed"}`;
  el.innerHTML = CHEVRON_SVG;
  el.title = open ? "접기" : "펼치기";
  return el;
}

/** Headings + list items become foldable. CM tries each foldService in turn. */
export const markdownFolding = [
  codeFolding(),
  foldService.of((state, lineStart) => headingRange(state, lineStart)),
  foldService.of((state, lineStart) => listRange(state, lineStart)),
  foldGutter({ markerDOM: foldMarkerDOM }),
  keymap.of(foldKeymap),
];
