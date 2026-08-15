import { Decoration, EditorView } from "@codemirror/view";
import { hide, type InlineFeature } from "../core";
import { isExternalUrl, openExternal } from "../../open-external";
import { isLocalDocumentLinkCandidate } from "../../local-doc-link";
import { requestDocumentOpen } from "../../document-open";

export const link: InlineFeature = {
  nodes: ["Link"],
  enter(node, ctx) {
    const marks = node.getChildren("LinkMark");
    const url = node.getChild("URL");
    if (marks.length < 2) return false;
    const textFrom = marks[0].to;
    const textTo = marks[1].from;
    const href = url ? ctx.state.sliceDoc(url.from, url.to) : null;
    ctx.push({ from: node.from, to: textFrom, deco: hide, conceal: true });
    ctx.push({ from: textTo, to: node.to, deco: hide, conceal: true });
    if (textTo > textFrom)
      ctx.push({
        from: textFrom,
        to: textTo,
        deco: Decoration.mark({
          class: "cm-link",
          // data-href is the shared "this opens externally" marker (see
          // open-external.ts) — only attached when the href actually
          // qualifies, so a relative/internal-looking href never masquerades
          // as clickable and the mousedown handler below can gate on its
          // mere presence. data-local-href (single-window-opening Todo 3) is
          // the SIBLING marker for a standard Markdown link that looks like a
          // safe in-vault document reference — reuses the exact same
          // candidate judgment the click-time resolver re-derives from, so
          // decoration and validation can never drift apart. The two markers
          // are mutually exclusive (external hrefs never pass
          // isLocalDocumentLinkCandidate — a scheme rejects them at parse
          // stage 8).
          attributes:
            href && isExternalUrl(href)
              ? { "data-href": href, title: href }
              : href && isLocalDocumentLinkCandidate(href)
                ? { "data-local-href": href, title: href }
                : {},
        }),
        conceal: false,
      });
    return false;
  },
  view: EditorView.domEventHandlers({
    mousedown(e) {
      const el = (e.target as HTMLElement).closest?.("[data-href]") as HTMLElement | null;
      const href = el?.dataset.href;
      // Gate belongs here even though data-href is only ever rendered for
      // external hrefs above: this handler is the single mousedown listener
      // for ALL of live-preview's inline `.cm-link` decorations (including
      // autolink's — see features/autolink.ts), so it re-affirms the same
      // predicate rather than trusting the marker alone.
      if (href && isExternalUrl(href)) {
        e.preventDefault();
        void openExternal(href, el);
        return true;
      }

      // data-local-href (single-window-opening Todo 3): a standard Markdown
      // link that parsed as a candidate in-vault document reference.
      // Right/middle-click and Alt+click fall through untouched — same rule
      // as attachAltClickEdit elsewhere (wikilink.ts) — so the caret/context
      // menu still works on a link-styled span instead of being swallowed.
      const localEl = (e.target as HTMLElement).closest?.("[data-local-href]") as HTMLElement | null;
      const localHref = localEl?.dataset.localHref;
      if (localHref) {
        if (e.button !== 0 || e.altKey) return false;
        e.preventDefault();
        requestDocumentOpen({ kind: "standard-link", href: localHref, feedbackEl: localEl });
        return true;
      }

      return false; // not ours — let CM place the caret
    },
  }),
};
