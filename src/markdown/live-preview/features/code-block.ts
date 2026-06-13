import { fencedInfo, revealed, type InlineFeature } from "../core";

export const codeBlock: InlineFeature = {
  nodes: ["FencedCode"],
  enter(node, ctx) {
    if (fencedInfo(ctx.state, node) === "mermaid") return false; // block widget owns it

    // The fence lines (```lang and the closing ```) are concealed to empty rows
    // that still occupy a full line + background, padding the box top and bottom.
    // Collapse them so the box hugs the code — UNLESS the caret is inside the
    // block, which reveals the raw source (fences shown) so the fence/language
    // stays editable. Obsidian-style: tight when unfocused, expanded when in it.
    // (In read mode `revealed` is always false, so the box is always tight.)
    const reveal = revealed(ctx.state, node.from, node.to);
    const first = ctx.state.doc.lineAt(node.from).from;
    const last = ctx.state.doc.lineAt(Math.max(node.from, node.to - 1)).from;
    ctx.eachLine(node.from, node.to, (lf) => {
      const fence = lf === first || lf === last;
      ctx.line(lf, fence && !reveal ? "cm-code-fence-hidden" : "cm-code-block");
    });
    return; // descend so CodeMark / CodeInfo get concealed
  },
};
