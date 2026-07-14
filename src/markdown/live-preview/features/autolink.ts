import { Decoration } from "@codemirror/view";
import { hide, type InlineFeature } from "../core";
import { isExternalUrl } from "../../open-external";

/** Bare-GFM-autolink text (`www.x`, `a@b.com`, `https://x`, `mailto:a@b.com`,
 *  …) → an href actually openable by the OS. GFM's Autolink/URL node keeps the
 *  original scheme-less text verbatim (that's what the parser matched), so
 *  this is the one place that fills in the missing scheme. `openExternal`'s
 *  `isExternalUrl` still gets the final say on whether the result is safe to
 *  hand to the opener. Pure query. */
export function autolinkHref(text: string): string {
  if (/^(https?:|mailto:|tel:)/i.test(text)) return text;
  if (/^www\./i.test(text)) return `https://${text}`;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return `mailto:${text}`;
  return text;
}

/**
 * Automatic URL detection: GFM's Autolink parser extension already produces
 * bare `https://…`/`www.…`/email text as a top-level `URL` node (no scheme
 * marks, no conceal target) and `<https://…>` as an `Autolink` node wrapping
 * `LinkMark` + `URL` children — both are enabled by `GFM` in parser.ts
 * already; no parser change needed here.
 *
 * Oversampling is a non-issue: `link.enter`/`image.enter` (features/link.ts,
 * features/image.ts) always `return false`, so `tree.iterate` never descends
 * into a `[text](url)`/`![alt](url)`'s children — the `URL` node inside a
 * markdown link/image never reaches this feature at all. Code spans and
 * fences never produce inline nodes to begin with. So the two "don't double-
 * render a link" guarantees are structural (tree shape + existing enter
 * contracts), not a runtime check re-litigated here.
 */
export const autolink: InlineFeature = {
  nodes: ["URL", "Autolink"],
  enter(node, ctx) {
    if (node.name === "Autolink") {
      // `<https://…>` — conceal the angle-bracket LinkMarks like every other
      // bracketed inline mark; the wrapped URL child is styled by the URL
      // branch below when tree.iterate descends into it.
      for (const mark of node.getChildren("LinkMark")) {
        if (mark.to > mark.from) ctx.push({ from: mark.from, to: mark.to, deco: hide, conceal: true });
      }
      return; // keep descending into the URL child
    }
    // node.name === "URL" — bare autolink text (top-level GFM match, or the
    // inner child of an Autolink wrapper). Style only; no marker to conceal.
    const text = ctx.state.sliceDoc(node.from, node.to);
    const href = autolinkHref(text);
    ctx.push({
      from: node.from,
      to: node.to,
      deco: Decoration.mark({
        class: "cm-link",
        // Same data-href contract as features/link.ts: only attach it when
        // the resolved href is actually openable (isExternalUrl) — e.g. an
        // `xmpp:` autolink stays styled text with nothing to click.
        attributes: isExternalUrl(href) ? { "data-href": href, title: href } : {},
      }),
      conceal: false,
    });
  },
};
