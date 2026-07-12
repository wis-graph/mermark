import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { hide, type InlineFeature } from "../core";

const HEADING_LINE: Record<string, string> = {
  ATXHeading1: "cm-h1",
  ATXHeading2: "cm-h2",
  ATXHeading3: "cm-h3",
  ATXHeading4: "cm-h4",
  ATXHeading5: "cm-h5",
  ATXHeading6: "cm-h6",
  SetextHeading1: "cm-h1",
  SetextHeading2: "cm-h2",
};

const HEADING_NODE_NAMES = new Set([...Object.keys(HEADING_LINE)]);

/** How many consecutive blank lines still count as "the same heading cluster".
 *  A gap wider than this is read as a real section break, not a run of
 *  adjacent headings — see continuesHeadingCluster below. */
const MAX_BLANK_LINES_IN_CLUSTER = 2;

/** Whether `headingLineFrom` CONTINUES a heading cluster: the nearest
 *  non-blank line above it is itself a heading AND within
 *  MAX_BLANK_LINES_IN_CLUSTER blank lines. This is the "consecutive heading
 *  cluster" rule that shrinks the top margin between adjacent headings
 *  (cm-heading-cont in styles.css) so H3→H4→H5→H6 runs read as one cluster
 *  instead of a list — named for the cluster-continuation decision it makes
 *  (not a bare geometric "is the previous line a heading" fact), since the
 *  skip cap means a heading beyond the gap does NOT continue the cluster
 *  even though it's still the nearest non-blank line above. Pure query. */
export function continuesHeadingCluster(state: EditorState, headingLineFrom: number): boolean {
  const doc = state.doc;
  let lineNo = doc.lineAt(headingLineFrom).number;
  let blanksSkipped = 0;
  while (lineNo > 1) {
    lineNo--;
    const line = doc.line(lineNo);
    if (line.text.trim() === "") {
      blanksSkipped++;
      if (blanksSkipped > MAX_BLANK_LINES_IN_CLUSTER) return false;
      continue;
    }
    let node = syntaxTree(state).resolveInner(line.from, 1);
    for (; node.parent; node = node.parent) {
      if (HEADING_NODE_NAMES.has(node.name)) return true;
    }
    return HEADING_NODE_NAMES.has(node.name);
  }
  return false;
}

export const heading: InlineFeature = {
  nodes: [...Object.keys(HEADING_LINE), "HeaderMark"],
  enter(node, ctx) {
    const h = HEADING_LINE[node.name];
    if (h) {
      const lineFrom = ctx.state.doc.lineAt(node.from).from;
      const cont = continuesHeadingCluster(ctx.state, lineFrom) ? " cm-heading-cont" : "";
      ctx.line(lineFrom, `cm-heading ${h}${cont}`);
      return; // descend so HeaderMark inside gets concealed
    }
    // HeaderMark: conceal `#` AND the space(s) after it, else the heading text
    // stays indented by that gap when the marker is hidden.
    let to = node.to;
    const lineEnd = ctx.state.doc.lineAt(node.from).to;
    while (to < lineEnd && ctx.state.sliceDoc(to, to + 1) === " ") to++;
    if (to > node.from) ctx.push({ from: node.from, to, deco: hide, conceal: true });
  },
};
