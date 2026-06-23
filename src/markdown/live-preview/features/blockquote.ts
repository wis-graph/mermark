import { Decoration } from "@codemirror/view";
import { hide, type InlineFeature } from "../core";
import { parseCalloutHead, resolveCalloutType } from "./callout-types";
import { CalloutHeadWidget } from "../../callout";

export const blockquote: InlineFeature = {
  nodes: ["QuoteMark", "Blockquote"],
  enter(node, ctx) {
    if (node.name === "QuoteMark") {
      if (node.to > node.from) ctx.push({ from: node.from, to: node.to, deco: hide, conceal: true });
      return;
    }
    // Blockquote: a `> [!type]` head turns the quote into a callout; otherwise
    // it gets a plain quote background + left rule (kept whether focused or not).
    const first = ctx.state.doc.lineAt(node.from);
    const head = parseCalloutHead(first.text);
    if (head) {
      const type = resolveCalloutType(head.type);
      const title = head.title || type.label;
      ctx.line(first.from, `cm-callout cm-callout-${type.key} cm-callout-head`);
      // Replace the `[!type] title` span (after the `> ` mark, to end of line)
      // with an icon + title widget. conceal:true → core reveals the raw head
      // when the caret enters the line (edit mode), re-conceals on leave.
      const markStart = first.from + first.text.indexOf("[!");
      ctx.push({
        from: markStart,
        to: first.to,
        deco: Decoration.replace({ widget: new CalloutHeadWidget(type.key, type.icon, title) }),
        conceal: true,
      });
      ctx.eachLine(first.to + 1 <= node.to ? first.to + 1 : node.to, node.to, (lf) =>
        ctx.line(lf, `cm-callout cm-callout-${type.key}`),
      );
    } else {
      ctx.eachLine(node.from, node.to, (lf) => ctx.line(lf, "cm-blockquote"));
    }
    // descend: quote marks + nested content
  },
};
