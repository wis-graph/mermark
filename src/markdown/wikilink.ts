import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";
import { scanWikilinks } from "./parser";

/** Resolve a wikilink target to an absolute .md path under baseDir. */
export function wikilinkPath(target: string, baseDir: string): string {
  const withExt = /\.[a-z0-9]+$/i.test(target) ? target : `${target}.md`;
  return `${baseDir.replace(/\/$/, "")}/${withExt}`;
}

class WikilinkWidget extends WidgetType {
  constructor(readonly alias: string, readonly path: string) { super(); }
  eq(o: WikilinkWidget) { return o.path === this.path && o.alias === this.alias; }
  toDOM() {
    const a = document.createElement("a");
    a.className = "cm-wikilink cm-wikilink-pending";
    a.textContent = this.alias;
    // existence check; toggle active/missing
    invoke<boolean>("path_exists", { path: this.path }).then((exists) => {
      a.classList.remove("cm-wikilink-pending");
      a.classList.add(exists ? "cm-wikilink-active" : "cm-wikilink-missing");
      if (exists) {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          invoke("open_path", { path: this.path });
        });
      }
    });
    return a;
  }
  ignoreEvent() { return true; }
}

export function wikilinkPlugin(baseDir: string) {
  function build(view: EditorView): DecorationSet {
    const ranges: { from: number; to: number; deco: Decoration }[] = [];
    const doc = view.state.doc;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      for (const hit of scanWikilinks(line.text, line.from)) {
        const path = wikilinkPath(hit.target, baseDir);
        ranges.push({ from: hit.from, to: hit.to, deco: Decoration.replace({ widget: new WikilinkWidget(hit.alias, path) }) });
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
