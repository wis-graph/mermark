import { fencedInfo, type BlockFeature } from "../core";
import { MermaidWidget } from "../../mermaid-widget";

export const mermaid: BlockFeature = {
  nodes: ["FencedCode"],
  match(node, ctx) {
    if (fencedInfo(ctx.state, node) !== "mermaid") return null;
    const lines = ctx.strippedLines(node.from, node.to);
    const body = lines.slice(1, lines[lines.length - 1]?.trim().startsWith("```") ? -1 : undefined);
    const src = body.join("\n");
    return { kind: "mermaid", from: node.from, to: node.to, src, widget: () => new MermaidWidget(src) };
  },
};
