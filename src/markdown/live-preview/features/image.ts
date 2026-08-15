import { Decoration } from "@codemirror/view";
import { type InlineFeature } from "../core";
import { ImageWidget, resolveImageUrl } from "../../image";
import { embedWidgetFor } from "../../embed";
import { isVaultImageRef, vaultImageContext } from "../../vault-image";
import { VaultImageWidget } from "../../vault-image-widget";

export const image: InlineFeature = {
  nodes: ["Image"],
  enter(node, ctx) {
    const url = node.getChild("URL");
    if (!url) return false;
    const marks = node.getChildren("LinkMark");
    const alt = marks.length >= 2 ? ctx.state.sliceDoc(marks[0].to, marks[1].from) : "";
    const raw = ctx.state.sliceDoc(url.from, url.to).trim();
    // A `vault:` reference (single-window-opening Wave 2) resolves against the
    // permanent-vault context slot rather than baseDir — checked first, ahead
    // of the youtube/video/plain-image priority below, since a vault
    // reference is never any of those. A YouTube link or a video file embeds
    // as its own widget; anything else is an image. embedWidgetFor owns the
    // youtube→video priority (shared with the `![[…]]` path).
    const widget = isVaultImageRef(raw)
      ? new VaultImageWidget(raw, alt, vaultImageContext())
      : (embedWidgetFor(raw, alt, ctx.baseDir) ??
        new ImageWidget(resolveImageUrl(raw, ctx.baseDir), alt, raw, ctx.baseDir));
    ctx.push({
      from: node.from,
      to: node.to,
      deco: Decoration.replace({ widget }),
      conceal: true,
    });
    return false;
  },
};
