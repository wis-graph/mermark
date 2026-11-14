import type { SyntaxNode } from "@lezer/common";
import type { Line, Text } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import type { InlineFeature } from "../core";

const indentMark = Decoration.mark({ class: "cm-list-indent" });
// Continuation lines collapse their raw leading whitespace to zero width, so
// lazy / 2-space / 4-space / tab continuations all start at the text column
// (padding-inline-start of the line) regardless of the source indentation.
const contIndentMark = Decoration.mark({ class: "cm-list-cont-indent" });

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

/** Number of leading space/tab characters of `lineText`. */
export function leadingWhitespaceLength(lineText: string): number {
  let i = 0;
  while (i < lineText.length && (lineText[i] === " " || lineText[i] === "\t")) i++;
  return i;
}

/** Source lines of a ListItem's `paragraph` that are NOT the item's first line
 *  (`itemFirstLineNo`): lazy or indented hard-wrap continuations, plus the first
 *  line of a second paragraph. Nested ListItems own their lines (they are
 *  siblings of Paragraph in the tree, never inside it), so a new item or nested
 *  list start is never returned. Pure query. */
export function continuationLines(doc: Text, paragraph: SyntaxNode, itemFirstLineNo: number): Line[] {
  const out: Line[] = [];
  const first = doc.lineAt(paragraph.from).number;
  const last = doc.lineAt(Math.max(paragraph.from, paragraph.to - 1)).number;
  for (let n = Math.max(first, itemFirstLineNo + 1); n <= last; n++) out.push(doc.line(n));
  return out;
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
    // Hard-wrapped / multi-paragraph item text: every later source line of this
    // item's own paragraphs hangs at the item's text column too.
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== "Paragraph") continue;
      for (const cont of continuationLines(ctx.state.doc, child, line.number)) {
        ctx.line(cont.from, `cm-list-line cm-list-cont cm-list-d${depth}`);
        const ws = leadingWhitespaceLength(cont.text);
        if (ws > 0) ctx.push({ from: cont.from, to: cont.from + ws, deco: contIndentMark, conceal: false });
      }
    }
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
