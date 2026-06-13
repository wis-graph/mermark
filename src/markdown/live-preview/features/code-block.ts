import { fencedInfo, type BlockFeature, type InlineFeature } from "../core";
import { CodeBlockWidget } from "../../code-widget";

/** Line backgrounds for fenced code (including mermaid's ```mermaid source).
 *  Only visible when the block is revealed for editing — otherwise the block
 *  widget covers these lines — so the source keeps its code background while you
 *  edit it. */
export const codeLines: InlineFeature = {
  nodes: ["FencedCode"],
  enter(node, ctx) {
    ctx.eachLine(node.from, node.to, (lf) => ctx.line(lf, "cm-code-line"));
    return; // descend so CodeMark etc. are handled
  },
};

/** A fenced code block becomes a block widget (same pipeline as mermaid/table/
 *  math): rendered as a styled box, and the raw ```lang … ``` source is revealed
 *  for editing when the caret enters it. Mermaid fences are owned by the mermaid
 *  feature, so they're skipped here. */
export const codeBlock: BlockFeature = {
  nodes: ["FencedCode"],
  match(node, ctx) {
    const lang = fencedInfo(ctx.state, node);
    if (lang === "mermaid") return null;
    const lines = ctx.strippedLines(node.from, node.to);
    // drop the opening ```lang line and the closing ``` line (if present)
    const body = lines
      .slice(1, lines[lines.length - 1]?.trim().startsWith("```") ? -1 : undefined)
      .join("\n");
    return {
      kind: "code",
      from: node.from,
      to: node.to,
      src: body,
      widget: () => new CodeBlockWidget(body, lang),
    };
  },
};
