import { fencedInfo, type BlockFeature } from "../core";
import { MermaidWidget } from "../../mermaid-widget";

export const mermaid: BlockFeature = {
  nodes: ["FencedCode"],
  match(node, ctx) {
    if (fencedInfo(ctx.state, node) !== "mermaid") return null;
    const src = ctx.fencedBody(node).join("\n");
    return { kind: "mermaid", from: node.from, to: node.to, src, widget: () => new MermaidWidget(src) };
  },
};
