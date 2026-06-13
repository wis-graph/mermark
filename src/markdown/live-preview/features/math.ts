import { Decoration } from "@codemirror/view";
import { type BlockFeature, type InlineFeature } from "../core";
import { KatexWidget } from "../../math-widget";

export const inlineMath: InlineFeature = {
  nodes: ["InlineMath"],
  enter(node, ctx) {
    const tex = ctx.state.sliceDoc(node.from + 1, node.to - 1).trim();
    ctx.push({
      from: node.from,
      to: node.to,
      deco: Decoration.replace({ widget: new KatexWidget(tex, false) }),
      conceal: true,
    });
    return false;
  },
};

export const blockMath: BlockFeature = {
  nodes: ["BlockMath"],
  match(node, ctx) {
    const raw = ctx.strippedLines(node.from, node.to).join("\n");
    const src = raw.replace(/^\s*\$\$/, "").replace(/\$\$\s*$/, "").trim();
    return { kind: "math", from: node.from, to: node.to, src, widget: () => new KatexWidget(src, true) };
  },
};
