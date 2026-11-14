import type { SyntaxNode } from "@lezer/common";
import { Decoration } from "@codemirror/view";
import type { InlineFeature } from "../core";

const indentMark = Decoration.mark({ class: "cm-list-indent" });

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

/** Start of the whitespace run that directly precedes `markFrom` on its line
 *  (== markFrom when nothing precedes it). The run is the item's source
 *  indentation, whatever it is made of (2 spaces, 4 spaces, tab, mixed). */
export function indentRunStart(lineText: string, lineFrom: number, markFrom: number): number {
  let i = markFrom - lineFrom;
  while (i > 0 && (lineText[i - 1] === " " || lineText[i - 1] === "\t")) i--;
  return lineFrom + i;
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
    const line = ctx.state.doc.lineAt(node.from);
    ctx.line(line.from, `cm-list-line cm-list-d${depth}`);
    // Deterministic nesting: the raw indentation run is shown inside a
    // fixed-width box (CSS: (depth-1) * --list-col), so item start depends on
    // the parsed depth, never on how many spaces/tabs the source used. It is a
    // plain mark (not concealed) so the caret still walks/edits the real
    // whitespace and revealing the marker never shifts anything.
    const mark = node.getChild("ListMark");
    if (!mark) return;
    const from = indentRunStart(line.text, line.from, mark.from);
    if (from < mark.from) ctx.push({ from, to: mark.from, deco: indentMark, conceal: false });
  },
};
