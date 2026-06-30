import { Decoration } from "@codemirror/view";
import { type InlineFeature } from "../core";
import { ImageWidget, resolveImageUrl } from "../../image";
import { embedWidgetFor } from "../../embed";
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
    // `![[…]]` embeds, in priority: youtube/video (embedWidgetFor) → image → a
    // plain wikilink. `[[…]]` (no `!`) is always a wikilink. Same youtube→video
    // priority as the `![](…)` path (shared embedWidgetFor).
    const embedWidget = embed ? embedWidgetFor(target, alias, ctx.baseDir) : null;
    const deco = embedWidget
      ? Decoration.replace({ widget: embedWidget })
      : embed && isImageTarget(target)
        ? Decoration.replace({
            widget: new ImageWidget(resolveImageUrl(target, ctx.baseDir), alias, target, ctx.baseDir),
          })
        : Decoration.replace({
            widget: new WikilinkWidget(alias, wikilinkPath(target, ctx.baseDir, ctx.currentFile)),
          });
    ctx.push({ from: node.from, to: node.to, deco, conceal: true });
    return false;
  },
};
