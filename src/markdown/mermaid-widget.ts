import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import mermaid from "mermaid";
import svgPanZoom from "svg-pan-zoom";

mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

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
}

/** Extract the inner code of a FencedCode node, dropping the ``` fences. */
function fenceBody(view: EditorView, from: number, to: number): string {
  const first = view.state.doc.lineAt(from);
  const last = view.state.doc.lineAt(to);
  const startLine = first.number + 1;
  const endLine = last.text.trim().startsWith("```") ? last.number - 1 : last.number;
  if (endLine < startLine) return "";
  return view.state.doc.sliceString(view.state.doc.line(startLine).from, view.state.doc.line(endLine).to);
}

function infoLang(view: EditorView, from: number): string {
  return view.state.doc.lineAt(from).text.replace(/^\s*`{3,}\s*/, "").trim().toLowerCase();
}

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "FencedCode" || infoLang(view, node.from) !== "mermaid") return;
        const code = fenceBody(view, node.from, node.to);
        b.add(node.from, node.to, Decoration.replace({ widget: new MermaidWidget(code), block: true }));
      },
    });
  }
  return b.finish();
}

export const mermaidBlocks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) {
      this.decorations = build(v);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
