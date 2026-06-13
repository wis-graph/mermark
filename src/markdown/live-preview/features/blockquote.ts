import { hide, type InlineFeature } from "../core";

const CALLOUT_HEAD = /^\s*(?:>\s*)+\[!(\w+)\]/;

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
    const head = CALLOUT_HEAD.exec(first.text);
    if (head) {
      const type = head[1].toLowerCase();
      ctx.line(first.from, `cm-callout cm-callout-${type} cm-callout-head`);
      ctx.eachLine(first.to + 1 <= node.to ? first.to + 1 : node.to, node.to, (lf) =>
        ctx.line(lf, `cm-callout cm-callout-${type}`),
      );
    } else {
      ctx.eachLine(node.from, node.to, (lf) => ctx.line(lf, "cm-blockquote"));
    }
    // descend: quote marks + nested content
  },
};
