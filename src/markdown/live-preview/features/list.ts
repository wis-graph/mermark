import { Decoration } from "@codemirror/view";
import { foldedRanges } from "@codemirror/language";
import { hide, type InlineFeature } from "../core";
import { BulletWidget } from "../../bullet";

const BULLET = /^[-*+]$/; // unordered marker; ordered marks like "1." are left as-is

/** Render an unordered list bullet as a CSS dot (Workflowy/Obsidian-style),
 *  with a halo when the item's children are folded. Ordered markers keep their
 *  number; task items keep just their checkbox (the dash is hidden). The mark
 *  un-conceals when the caret is on its line, so the raw "- " stays editable. */
export const list: InlineFeature = {
  nodes: ["ListMark"],
  enter(node, ctx) {
    const mark = ctx.state.sliceDoc(node.from, node.to);
    if (!BULLET.test(mark)) return; // ordered list → leave the number visible

    // task item ("- [ ] …"): the checkbox owns the visual, so just hide the dash
    const after = ctx.state.sliceDoc(node.to, Math.min(node.to + 4, ctx.state.doc.length));
    if (/^\s?\[[ xX]\]/.test(after)) {
      ctx.push({ from: node.from, to: node.to, deco: hide, conceal: true });
      return;
    }

    // collapsed? a fold that starts at the end of this item's first line means
    // its children are hidden → draw the bullet with a halo.
    const item = node.parent; // ListItem
    let collapsed = false;
    if (item) {
      const firstLineEnd = ctx.state.doc.lineAt(item.from).to;
      foldedRanges(ctx.state).between(item.from, item.to, (from) => {
        if (from === firstLineEnd) collapsed = true;
      });
    }

    ctx.push({
      from: node.from,
      to: node.to,
      deco: Decoration.replace({ widget: new BulletWidget(collapsed) }),
      conceal: true,
    });
  },
};
