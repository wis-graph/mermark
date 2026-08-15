import { Decoration } from "@codemirror/view";
import { type InlineFeature } from "../core";
import { ImageWidget, resolveImageUrl } from "../../image";
import { embedWidgetFor } from "../../embed";

export const image: InlineFeature = {
  nodes: ["Image"],
  enter(node, ctx) {
    const url = node.getChild("URL");
    if (!url) return false;
    const marks = node.getChildren("LinkMark");
    const alt = marks.length >= 2 ? ctx.state.sliceDoc(marks[0].to, marks[1].from) : "";
    const raw = ctx.state.sliceDoc(url.from, url.to).trim();
    // `![](target)` is always document-folder scope (a literal/relative
    // path, or its depth-3 basename fallback) — the explicit escape hatch
    // for when a name search (`![[name]]`, wikilink.ts) picks the wrong
    // file (`_workspace/00_request_vaultimage_fix.md`'s table). A YouTube
    // link or a video file embeds as its own widget; anything else is an
    // image. embedWidgetFor owns the youtube→video priority (shared with
    // the `![[…]]` path).
    const widget =
      embedWidgetFor(raw, alt, ctx.baseDir) ?? new ImageWidget(resolveImageUrl(raw, ctx.baseDir), alt, raw, ctx.baseDir);
    ctx.push({
      from: node.from,
      to: node.to,
      deco: Decoration.replace({ widget }),
      conceal: true,
    });
    return false;
  },
};
