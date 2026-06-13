import { Decoration } from "@codemirror/view";
import { type InlineFeature } from "../core";
import { SupWidget } from "../../footnote";

export const footnote: InlineFeature = {
  nodes: ["FootnoteRef"],
  enter(node, ctx) {
    const line = ctx.state.doc.lineAt(node.from);
    const isDef = node.from === line.from && ctx.state.sliceDoc(node.to, node.to + 1) === ":";
    if (isDef) {
      ctx.line(line.from, "cm-footnote-def");
    } else {
      const label = ctx.state.sliceDoc(node.from + 2, node.to - 1);
      ctx.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({ widget: new SupWidget(label) }),
        conceal: true,
      });
    }
    return false;
  },
};
