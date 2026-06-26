import { type BlockFeature } from "../core";
import { FrontmatterWidget } from "../../frontmatter-widget";

/** The document's top YAML frontmatter block → an Obsidian-style key/value
 *  table widget. Same StateField path as the table feature, so the block
 *  decoration is never emitted from a ViewPlugin (render-smoke invariant). */
export const frontmatter: BlockFeature = {
  nodes: ["Frontmatter"],
  match(node, ctx) {
    const src = ctx.strippedLines(node.from, node.to).join("\n");
    return {
      kind: "frontmatter",
      from: node.from,
      to: node.to,
      src,
      widget: () => new FrontmatterWidget(src),
    };
  },
};
