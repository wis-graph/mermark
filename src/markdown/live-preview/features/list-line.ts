import type { SyntaxNode } from "@lezer/common";
import type { InlineFeature } from "../core";

// P2 (wrap hanging indent) + P3 (nested indent guide) — design:
// `_workspace/01_architect_design.md` §"P2·wrap hanging indent + P3·인덴트 가이드".
// Both are the SAME line-class family (`cm-list-line cm-list-d{n}`); CSS alone
// tells row1 vs wrapped-row2+ apart via text-indent/padding, and paints the
// guide via background-image on the identical class — no second decoration
// pass. This feature only computes depth and emits the class.

/** Cap on `cm-list-d{n}` classes — deeper items still get depth 1..MAX_DEPTH
 *  worth of indent/guide (clamped), matching styles.css's `.cm-list-d1..d6`. */
const MAX_DEPTH = 6;

/** How many ListItem ancestors wrap this node, itself included (1-based). The
 *  nesting depth of a list item — same "walk the ListItem ancestor chain"
 *  pattern as fold.ts's `listRange` and list-indent.ts's `lineIsListItem`. */
export function listItemDepth(item: SyntaxNode): number {
  let depth = 0;
  for (let n: SyntaxNode | null = item; n; n = n.parent) {
    if (n.name === "ListItem") depth++;
  }
  return depth;
}

/** True when this ListItem's marker is an ordered one ("1." / "2)" …). The
 *  hanging indent must match the RENDERED marker width, and ordered markers
 *  (number+dot+space, left visible by the `list` feature) are ~half a char
 *  wider than the concealed bullet dot — so the line class splits the
 *  --list-marker token per marker kind (see styles.css .cm-list-ordered). */
function isOrderedItem(item: SyntaxNode, text: (from: number, to: number) => string): boolean {
  const mark = item.getChild("ListMark");
  if (!mark) return false;
  const ch = text(mark.from, Math.min(mark.from + 1, mark.to));
  return ch >= "0" && ch <= "9";
}

/** Depth-based line class for every list item's first source line — drives
 *  hanging indent (P2) and the nested indent guide (P3) purely through CSS.
 *  Nested ListItem nodes are visited independently by the tree walk, so each
 *  emits its own first line once; this feature never descends manually. The
 *  dash/number marker itself stays owned by the `list` feature (conceal). */
export const listLine: InlineFeature = {
  nodes: ["ListItem"],
  enter(node, ctx) {
    const depth = Math.min(listItemDepth(node), MAX_DEPTH);
    const lineFrom = ctx.state.doc.lineAt(node.from).from;
    const ordered = isOrderedItem(node, (a, b) => ctx.state.sliceDoc(a, b));
    ctx.line(lineFrom, `cm-list-line cm-list-d${depth}${ordered ? " cm-list-ordered" : ""}`);
  },
};
