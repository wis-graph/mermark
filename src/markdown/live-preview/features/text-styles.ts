import { Decoration } from "@codemirror/view";
import { hide, type InlineFeature } from "../core";

// Emphasis/strong/code/strikethrough get a styling class; their markers
// (`*`, `` ` ``, `~`, and a fence's language token) are concealed.
const STYLE: Record<string, string> = {
  StrongEmphasis: "cm-strong",
  Emphasis: "cm-em",
  InlineCode: "cm-inline-code",
  Strikethrough: "cm-strike",
};

export const textStyles: InlineFeature = {
  nodes: [...Object.keys(STYLE), "EmphasisMark", "CodeMark", "CodeInfo", "StrikethroughMark"],
  enter(node, ctx) {
    const cls = STYLE[node.name];
    if (cls) {
      ctx.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: cls }), conceal: false });
      return; // descend so the inner marks get concealed
    }
    if (node.to > node.from) ctx.push({ from: node.from, to: node.to, deco: hide, conceal: true });
  },
};
