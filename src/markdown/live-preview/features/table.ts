import { type BlockFeature } from "../core";
import { TableWidget } from "../../table-widget";

export const table: BlockFeature = {
  nodes: ["Table"],
  match(node, ctx) {
    const src = ctx.strippedLines(node.from, node.to).join("\n");
    return { kind: "table", from: node.from, to: node.to, src, widget: () => new TableWidget(src) };
  },
};
