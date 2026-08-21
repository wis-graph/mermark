import { Decoration, EditorView } from "@codemirror/view";
import { hide, type InlineFeature } from "../core";
import { parseCalloutHead, resolveCalloutType } from "./callout-types";
import { CalloutHeadWidget } from "../../callout";
import { QuoteCopyWidget, quoteClipboardText, isTopLevelQuote, quoteRunHead } from "../../quote-copy";

// Toggles `cm-copy-visible` on the quote-run's head button when the pointer
// hovers ANY of the run's lines. A blockquote has no wrapper DOM (its lines
// are plain sibling `.cm-line`s), so CSS `:hover` can't express "hovering
// line 3 reveals the button that lives on line 1" — this delegate is the one
// place that rule is decided (quoteRunHead names it), rather than each
// widget/feature guessing selection/hover state on its own.
function quoteButton(lineEl: HTMLElement | null): HTMLElement | null {
  const head = lineEl && quoteRunHead(lineEl);
  return head?.querySelector<HTMLElement>(".cm-quote-copy") ?? null;
}
const quoteHoverView = EditorView.domEventHandlers({
  mouseover(event) {
    const lineEl = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      ".cm-blockquote, .cm-callout",
    );
    quoteButton(lineEl ?? null)?.classList.add("cm-copy-visible");
    return false;
  },
  mouseout(event) {
    const lineEl = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      ".cm-blockquote, .cm-callout",
    );
    quoteButton(lineEl ?? null)?.classList.remove("cm-copy-visible");
    return false;
  },
});

export const blockquote: InlineFeature = {
  nodes: ["QuoteMark", "Blockquote"],
  view: quoteHoverView,
  enter(node, ctx) {
    if (node.name === "QuoteMark") {
      if (node.to > node.from) ctx.push({ from: node.from, to: node.to, deco: hide, conceal: true });
      return;
    }
    // Blockquote: a `> [!type]` head turns the quote into a callout; otherwise
    // it gets a plain quote background + left rule (kept whether focused or not).
    const first = ctx.state.doc.lineAt(node.from);
    // One copy button per quote RUN, on its outermost node only — nested
    // `>>` must not stack a second button on the same first line.
    if (isTopLevelQuote(node)) {
      ctx.push({
        from: first.to,
        to: first.to,
        deco: Decoration.widget({
          widget: new QuoteCopyWidget(quoteClipboardText(ctx.state, node)),
          side: 1,
        }),
        conceal: false,
      });
    }
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
      // Structural first/last boundary (design §4.2): gated on isTopLevelQuote
      // so a nested `>>` never puts a corner class on its INNER Blockquote
      // node's edges — only the outermost run's real first/last source line
      // gets rounded. Tracked in the same eachLine walk that applies the
      // plain "cm-blockquote" class, so the boundary can never drift from
      // which lines actually got that class.
      let firstLineFrom: number | null = null;
      let lastLineFrom = node.from;
      ctx.eachLine(node.from, node.to, (lf) => {
        ctx.line(lf, "cm-blockquote");
        if (firstLineFrom === null) firstLineFrom = lf;
        lastLineFrom = lf;
      });
      if (isTopLevelQuote(node)) {
        if (firstLineFrom !== null) ctx.line(firstLineFrom, "cm-blockquote-first");
        ctx.line(lastLineFrom, "cm-blockquote-last"); // same line as -first on a 1-line quote — combines
      }
    }
    // descend: quote marks + nested content
  },
};
