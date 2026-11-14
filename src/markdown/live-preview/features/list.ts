import { Decoration } from "@codemirror/view";
import { foldedRanges } from "@codemirror/language";
import { hide, type InlineFeature } from "../core";
import { BulletWidget } from "../../bullet";

const BULLET = /^[-*+]$/; // unordered marker; ordered marks like "1." are left as-is
const TASK_BOX = /^([ \t]*)(\[[ xX]\])([ \t]*)/; // what follows a task item's dash

// Every marker kind lives in one fixed-width "marker box" (CSS --list-col) so
// the text column never depends on the marker kind or on reveal state: the box
// is a non-concealed mark over the whole marker source ("- ", "1. ", "- [ ] "),
// and the concealed rendering (bullet / checkbox widget) fills the same box.
const markerBullet = Decoration.mark({ class: "cm-list-marker cm-list-marker-bullet" });
const markerOrdered = Decoration.mark({ class: "cm-list-marker cm-list-marker-ordered" });
const markerTask = Decoration.mark({ class: "cm-list-marker cm-list-marker-task" });

/** End of the spaces/tabs run starting at `pos` (capped at `lineTo`). */
function skipBlanks(text: string, pos: number, lineFrom: number, lineTo: number): number {
  let i = pos - lineFrom;
  while (lineFrom + i < lineTo && (text[i] === " " || text[i] === "\t")) i++;
  return lineFrom + i;
}

/** Render an unordered list bullet as a CSS dot (Workflowy/Obsidian-style),
 *  with a halo when the item's children are folded. Ordered markers keep their
 *  number (right-aligned in the marker box); task items keep just their
 *  checkbox (dash + spaces hidden). The marks un-conceal when the caret is on
 *  the line, so the raw "- " stays editable inside the same fixed-width box. */
export const list: InlineFeature = {
  nodes: ["ListMark"],
  enter(node, ctx) {
    const mark = ctx.state.sliceDoc(node.from, node.to);
    const line = ctx.state.doc.lineAt(node.from);
    const afterMark = skipBlanks(line.text, node.to, line.from, line.to);

    // task item ("- [ ] …"): the checkbox owns the visual, so hide the dash
    // and the spaces around it; the box spans "- [ ] " in full.
    const task = TASK_BOX.exec(line.text.slice(node.to - line.from));
    if (task && (BULLET.test(mark) || /^\d/.test(mark))) {
      const boxStart = node.to + task[1].length;
      const boxEnd = boxStart + task[2].length + task[3].length;
      ctx.push({ from: node.from, to: boxEnd, deco: markerTask, conceal: false });
      ctx.push({ from: node.from, to: boxStart, deco: hide, conceal: true });
      if (task[3].length) {
        ctx.push({ from: boxStart + task[2].length, to: boxEnd, deco: hide, conceal: true });
      }
      return;
    }

    if (!BULLET.test(mark)) {
      // ordered list → number stays visible, only boxed/right-aligned
      ctx.push({ from: node.from, to: afterMark, deco: markerOrdered, conceal: false });
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

    ctx.push({ from: node.from, to: afterMark, deco: markerBullet, conceal: false });
    ctx.push({
      from: node.from,
      to: afterMark,
      deco: Decoration.replace({ widget: new BulletWidget(collapsed) }),
      conceal: true,
    });
  },
};
