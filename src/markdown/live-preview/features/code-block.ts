import { fencedInfo, type InlineFeature } from "../core";

export const codeBlock: InlineFeature = {
  nodes: ["FencedCode"],
  enter(node, ctx) {
    if (fencedInfo(ctx.state, node) === "mermaid") return false; // block widget owns it
    ctx.eachLine(node.from, node.to, (lf) => ctx.line(lf, "cm-code-block"));
    return; // descend so CodeMark / CodeInfo get concealed
  },
};
