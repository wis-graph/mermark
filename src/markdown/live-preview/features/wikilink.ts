import { Decoration } from "@codemirror/view";
import { type InlineFeature } from "../core";
import { ImageWidget, resolveImageUrl } from "../../image";
import { WikilinkWidget, wikilinkPath, isImageTarget } from "../../wikilink";

export const wikilink: InlineFeature = {
  nodes: ["Wikilink", "WikilinkEmbed"],
  enter(node, ctx) {
    const targetNode = node.getChild("WikilinkTarget");
    const target = ctx.state
      .sliceDoc(targetNode?.from ?? node.from, targetNode?.to ?? node.from)
      .trim();
    const aliasNode = node.getChild("WikilinkAlias");
    const alias = aliasNode ? ctx.state.sliceDoc(aliasNode.from, aliasNode.to).trim() : target;
    if (!target) return false;
    const embed = node.name === "WikilinkEmbed";
    const deco =
      embed && isImageTarget(target)
        ? Decoration.replace({ widget: new ImageWidget(resolveImageUrl(target, ctx.baseDir), alias) })
        : Decoration.replace({
            widget: new WikilinkWidget(alias, wikilinkPath(target, ctx.baseDir, ctx.currentFile)),
          });
    ctx.push({ from: node.from, to: node.to, deco, conceal: true });
    return false;
  },
};
