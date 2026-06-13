import { Decoration } from "@codemirror/view";
import { type InlineFeature } from "../core";
import { ImageWidget, resolveImageUrl } from "../../image";

export const image: InlineFeature = {
  nodes: ["Image"],
  enter(node, ctx) {
    const url = node.getChild("URL");
    if (!url) return false;
    const marks = node.getChildren("LinkMark");
    const alt = marks.length >= 2 ? ctx.state.sliceDoc(marks[0].to, marks[1].from) : "";
    const src = resolveImageUrl(ctx.state.sliceDoc(url.from, url.to).trim(), ctx.baseDir);
    ctx.push({
      from: node.from,
      to: node.to,
      deco: Decoration.replace({ widget: new ImageWidget(src, alt) }),
      conceal: true,
    });
    return false;
  },
};
