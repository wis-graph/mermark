import { WidgetType } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { strippedLines } from "./live-preview/core";
import { parseCalloutHead } from "./live-preview/features/callout-types";
import { createCopyButton } from "./copy-button";

// The blockquote copy button's domain rules, kept as pure functions so the
// "what does copying a quote actually mean" question has one testable answer
// (tests/quote-copy.test.ts), independent of the CM widget/feature plumbing
// that renders it.

/** Drop the callout head line (`[!type] title`) from `lines` if present — the
 *  head is the callout's own chrome (rendered as an icon+title chip), not
 *  content, so a copy of the quote shouldn't include it. Mirrors
 *  `dropFences`'s "chrome vs. content" split for fenced code.
 *
 *  `lines` here are already ONE `>` layer stripped (quoteClipboardText's
 *  contract), but `parseCalloutHead`'s regex requires at least one leading
 *  `>` marker (it's normally run on the raw, unstripped line — see
 *  blockquote.ts). Re-adding a single synthetic `> ` lets this reuse that
 *  SSOT regex unchanged rather than forking a second "is this a callout
 *  head" pattern. Pure query. */
export function dropCalloutHead(lines: string[]): string[] {
  return lines.length > 0 && parseCalloutHead(`> ${lines[0]}`) != null ? lines.slice(1) : lines;
}

/** True when `node` has no ancestor Blockquote — the copy button attaches
 *  only to the outermost quote of a nested run, never once per nesting
 *  level. Pure query over the syntax tree. */
export function isTopLevelQuote(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.name === "Blockquote") return false;
  return true;
}

/** The text the quote copy button writes: every line of the quote with
 *  exactly ONE enclosing `>` layer removed — nested `>>` keeps its inner
 *  `> …` marker, an empty `>` line becomes an empty line, and content lines
 *  (code fences, list items) are otherwise verbatim — plus the callout head
 *  line dropped, if any. Always computed from `state.doc`, never from
 *  rendered DOM, so it's correct whether or not the quote is currently
 *  revealed. Pure query. */
export function quoteClipboardText(state: EditorState, node: SyntaxNode): string {
  const lines = strippedLines(state, node.from, node.to, 1);
  return dropCalloutHead(lines).join("\n");
}

/** True when `el` is a rendered quote/callout line (the CM line classes
 *  `ctx.line()` attaches — see live-preview/features/blockquote.ts). */
function isQuoteLine(el: Element | null): el is HTMLElement {
  return el != null && (el.classList.contains("cm-blockquote") || el.classList.contains("cm-callout"));
}

/** Given a hovered quote/callout line element, walk back through its
 *  preceding sibling lines to find the first line of this quote "run" — the
 *  line the copy button widget lives on. Named because a blockquote has no
 *  wrapper DOM (each rendered line is a sibling `.cm-line`), so CSS `:hover`
 *  alone can't make hovering ANY line of the quote reveal the one button on
 *  its first line; this is the domain rule that answers "which line's button
 *  to show" for that delegation. Returns null if `el` isn't a quote line.
 *  Pure DOM query — no side effects. */
export function quoteRunHead(el: HTMLElement): HTMLElement | null {
  if (!isQuoteLine(el)) return null;
  let head: HTMLElement = el;
  let prev = head.previousElementSibling;
  while (isQuoteLine(prev)) {
    head = prev;
    prev = head.previousElementSibling;
  }
  return head;
}

/** The blockquote's copy button. Inline point widget (not a block widget —
 *  the quote's lines are never replaced, only decorated), so it comes from
 *  the ViewPlugin pipeline like the callout head widget, not a StateField. */
export class QuoteCopyWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: QuoteCopyWidget) {
    return o.text === this.text;
  }
  toDOM() {
    return createCopyButton(this.text, "인용 복사", "cm-quote-copy");
  }
}
