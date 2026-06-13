import { Decoration, EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { hide, type InlineFeature } from "../core";

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
          attributes: href ? { "data-href": href, title: href } : {},
        }),
        conceal: false,
      });
    return false;
  },
  view: EditorView.domEventHandlers({
    mousedown(e) {
      const el = (e.target as HTMLElement).closest?.("[data-href]") as HTMLElement | null;
      if (!el?.dataset.href) return false;
      e.preventDefault();
      invoke("plugin:opener|open_url", { url: el.dataset.href }).catch(() => {
        window.open(el.dataset.href ?? undefined, "_blank");
      });
      return true;
    },
  }),
};
