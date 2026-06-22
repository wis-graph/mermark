import { Decoration } from "@codemirror/view";
import { hide, type InlineFeature } from "../core";

// Emphasis/strong/code/strikethrough get a styling class; their markers
// (`*`, `` ` ``, `~`) are concealed.
const STYLE: Record<string, string> = {
  StrongEmphasis: "cm-strong",
  Emphasis: "cm-em",
  InlineCode: "cm-inline-code",
  Strikethrough: "cm-strike",
  Highlight: "cm-highlight",
};

export const textStyles: InlineFeature = {
  nodes: [...Object.keys(STYLE), "EmphasisMark", "CodeMark", "StrikethroughMark", "HighlightMark"],
  enter(node, ctx) {
    const cls = STYLE[node.name];
    if (cls) {
      ctx.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: cls }), conceal: false });
      return; // descend so the inner marks get concealed
    }
    // A CodeMark on a fenced code block (``` / ```lang) belongs to the code
    // block widget; leave it raw so it shows when the block is revealed for
    // editing. Only conceal inline code's backticks.
    if (node.name === "CodeMark" && node.parent?.name === "FencedCode") return;
    if (node.to > node.from) ctx.push({ from: node.from, to: node.to, deco: hide, conceal: true });
  },
};
