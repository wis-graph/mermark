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

export const heading: InlineFeature = {
  nodes: [...Object.keys(HEADING_LINE), "HeaderMark"],
  enter(node, ctx) {
    const h = HEADING_LINE[node.name];
    if (h) {
      ctx.line(ctx.state.doc.lineAt(node.from).from, `cm-heading ${h}`);
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
