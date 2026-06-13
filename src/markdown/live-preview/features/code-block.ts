import { fencedInfo, modeFacet, type InlineFeature } from "../core";

export const codeBlock: InlineFeature = {
  nodes: ["FencedCode"],
  enter(node, ctx) {
    if (fencedInfo(ctx.state, node) === "mermaid") return false; // block widget owns it

    // The fence lines (```lang and the closing ```) are concealed to empty
    // lines that still occupy a full row + background, padding the box top and
    // bottom. In read mode (no editing) collapse them so the box hugs the code.
    // In edit mode they stay — they're reachable/editable and reveal on focus.
    const readMode = ctx.state.facet(modeFacet) === "read";
    const first = ctx.state.doc.lineAt(node.from).from;
    const last = ctx.state.doc.lineAt(Math.max(node.from, node.to - 1)).from;
    ctx.eachLine(node.from, node.to, (lf) => {
      const fence = lf === first || lf === last;
      ctx.line(lf, fence && readMode ? "cm-code-fence-hidden" : "cm-code-block");
    });
    return; // descend so CodeMark / CodeInfo get concealed
  },
};
