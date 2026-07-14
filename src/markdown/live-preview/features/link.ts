import { Decoration, EditorView } from "@codemirror/view";
import { hide, type InlineFeature } from "../core";
import { isExternalUrl, openExternal } from "../../open-external";

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
          // mere presence.
          attributes: href && isExternalUrl(href) ? { "data-href": href, title: href } : {},
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
      if (!href || !isExternalUrl(href)) return false; // not ours — let CM place the caret
      e.preventDefault();
      void openExternal(href, el);
      return true;
    },
  }),
};
