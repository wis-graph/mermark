import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { convertFileSrc } from "@tauri-apps/api/core";

/** Resolve a markdown image target to an absolute filesystem path (or pass through URLs). */
export function resolveImageSrc(src: string, baseDir: string): string {
  if (/^https?:\/\//i.test(src) || src.startsWith("data:")) return src;
  if (src.startsWith("/")) return src;
  return `${baseDir.replace(/\/$/, "")}/${src}`;
}

class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) { super(); }
  eq(o: ImageWidget) { return o.url === this.url; }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-image";
    img.alt = this.alt;
    img.src = this.url;
    return img;
  }
  ignoreEvent() { return true; }
}

const IMG = /!\[([^\]]*)\]\(([^)]+)\)/g;

export function imagePlugin(baseDir: string) {
  function build(view: EditorView): DecorationSet {
    const ranges: { from: number; to: number; deco: Decoration }[] = [];
    const doc = view.state.doc;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      let m: RegExpExecArray | null;
      IMG.lastIndex = 0;
      while ((m = IMG.exec(line.text))) {
        const abs = resolveImageSrc(m[2].trim(), baseDir);
        const url = /^https?:|^data:/i.test(abs) ? abs : convertFileSrc(abs);
        const from = line.from + m.index;
        ranges.push({ from, to: from + m[0].length, deco: Decoration.replace({ widget: new ImageWidget(url, m[1]) }) });
      }
    }
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const b = new RangeSetBuilder<Decoration>();
    for (const r of ranges) b.add(r.from, r.to, r.deco);
    return b.finish();
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(v: EditorView) { this.decorations = build(v); }
      update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
    },
    { decorations: (v) => v.decorations },
  );
}
