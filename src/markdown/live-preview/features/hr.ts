import { Decoration } from "@codemirror/view";
import { type InlineFeature } from "../core";
import { HrWidget } from "../../hr";

/** `---` thematic break → a horizontal rule. Reveals its raw source when the
 *  caret is on the line, like every other concealed marker. */
export const hr: InlineFeature = {
  nodes: ["HorizontalRule"],
  enter(node, ctx) {
    ctx.push({
      from: node.from,
      to: node.to,
      deco: Decoration.replace({ widget: new HrWidget() }),
      conceal: true,
    });
    return false;
  },
};
