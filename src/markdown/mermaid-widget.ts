import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import mermaid from "mermaid";
import svgPanZoom from "svg-pan-zoom";

let idSeq = 0;

class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.code === this.code;
  }
  toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-mermaid";
    const id = `mmd-${idSeq++}`;
    mermaid
      .render(id, this.code)
      .then(({ svg, bindFunctions }) => {
        host.innerHTML = svg;
        bindFunctions?.(host);
        const el = host.querySelector<SVGSVGElement>("svg");
        if (!el) return;
        el.removeAttribute("height");
        el.style.width = "100%";
        const pz = svgPanZoom(el, {
          panEnabled: true,
          zoomEnabled: true,
          mouseWheelZoomEnabled: false, // we gate wheel on Ctrl/Cmd manually
          dblClickZoomEnabled: false,
          fit: true,
          center: true,
        });
        (host as unknown as { __pz?: { destroy(): void } }).__pz = pz;
        let zoomed = false;
        host.addEventListener("dblclick", (e) => {
          e.preventDefault();
          if (zoomed) { pz.reset(); zoomed = false; } else { pz.zoomBy(2); zoomed = true; }
        });
        host.addEventListener(
          "wheel",
          (e) => {
            if (!(e.ctrlKey || e.metaKey)) return; // plain wheel = page scroll
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            pz.zoomAtPointBy(e.deltaY < 0 ? 1.15 : 0.87, point);
          },
          { passive: false },
        );
        host.dispatchEvent(new CustomEvent("mermaid-rendered", { bubbles: true }));
      })
      .catch((err) => {
        host.innerHTML = "";
        const pre = document.createElement("pre");
        pre.className = "cm-mermaid-error";
        pre.textContent = `Mermaid error: ${err?.message ?? err}\n\n${this.code}`;
        host.appendChild(pre);
      });
    return host;
  }
  ignoreEvent() {
    return true;
  }
  destroy(dom: HTMLElement): void {
    const pz = (dom as unknown as { __pz?: { destroy(): void } }).__pz;
    try { pz?.destroy(); } catch { /* already gone */ }
  }
}

/** Extract the inner code of a FencedCode node, dropping the ``` fences. */
function fenceBody(state: EditorState, from: number, to: number): string {
  const first = state.doc.lineAt(from);
  const last = state.doc.lineAt(to);
  const startLine = first.number + 1;
  const endLine = last.text.trim().startsWith("```") ? last.number - 1 : last.number;
  if (endLine < startLine) return "";
  return state.doc.sliceString(state.doc.line(startLine).from, state.doc.line(endLine).to);
}

function infoLang(state: EditorState, from: number): string {
  return state.doc.lineAt(from).text.replace(/^\s*`{3,}\s*/, "").trim().toLowerCase();
}

// Block decorations (block:true) MUST come from a StateField, not a ViewPlugin —
// CM6 throws "Block decorations may not be specified via plugins" otherwise.
// The whole tree is scanned (not just visible ranges) since a StateField has no viewport.
function build(state: EditorState): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode" || infoLang(state, node.from) !== "mermaid") return;
      const code = fenceBody(state, node.from, node.to);
      b.add(node.from, node.to, Decoration.replace({ widget: new MermaidWidget(code), block: true }));
    },
  });
  return b.finish();
}

export const mermaidBlocks = StateField.define<DecorationSet>({
  create(state) {
    return build(state);
  },
  update(deco, tr) {
    return tr.docChanged ? build(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
