import { Decoration } from "@codemirror/view";
import { type InlineFeature } from "../core";
import { CheckboxWidget } from "../../checkbox";

export const task: InlineFeature = {
  nodes: ["TaskMarker"],
  enter(node, ctx) {
    const checked = /x/i.test(ctx.state.sliceDoc(node.from, node.to));
    ctx.push({
      from: node.from,
      to: node.to,
      deco: Decoration.replace({ widget: new CheckboxWidget(checked) }),
      conceal: true,
    });
    return false;
  },
};
