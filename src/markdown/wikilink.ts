import { EditorView, WidgetType } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { openPath as openAsset } from "@tauri-apps/plugin-opener";

function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/**
 * Resolve a wikilink target to an absolute path under baseDir.
 * `#heading` / `#^block` suffixes are stripped for file resolution;
 * a bare `[[#heading]]` resolves to the current file itself.
 */
export function wikilinkPath(target: string, baseDir: string, currentFile?: string): string {
  const file = target.split("#")[0].trim();
  if (!file) return currentFile ?? "";
  if (file.startsWith("/")) return /\.[a-z0-9]+$/i.test(file) ? file : `${file}.md`;
  const withExt = /\.[a-z0-9]+$/i.test(file) ? file : `${file}.md`;
  return `${baseDir.replace(/\/$/, "")}/${withExt}`;
}

/** Whether an embed target (`![[…]]`) is an image we can inline. */
export function isImageTarget(target: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(target.split("#")[0].trim());
}

export class WikilinkWidget extends WidgetType {
  constructor(readonly alias: string, readonly path: string) {
    super();
  }
  eq(o: WikilinkWidget) {
    return o.path === this.path && o.alias === this.alias;
  }
  toDOM(view: EditorView) {
    const a = document.createElement("a");
    a.className = "cm-wikilink cm-wikilink-pending";
    a.textContent = this.alias;
    if (!this.path) {
      // same-file anchor like [[#heading]] — nothing to open
      a.classList.remove("cm-wikilink-pending");
      a.classList.add("cm-wikilink-active");
      return a;
    }
    
    const isMd = isMarkdownPath(this.path);

    invoke<boolean>("path_exists", { path: this.path }).then((exists) => {
      a.classList.remove("cm-wikilink-pending");
      a.classList.add(exists ? "cm-wikilink-active" : "cm-wikilink-missing");
      
      a.addEventListener("click", (e) => {
        e.preventDefault();
        
        if (exists) {
          if (isMd) {
            invoke("open_path", { path: this.path }).catch((err: any) => {
              a.classList.add("cm-wikilink-error");
              a.title = `Failed to open: ${String(err)}`;
            });
          } else {
            openAsset(this.path).catch((err: any) => {
              a.classList.add("cm-wikilink-error");
              a.title = `Failed to open asset: ${String(err)}`;
            });
          }
        } else {
          // File does not exist
          if (isMd) {
            invoke("create_markdown_file", { path: this.path })
              .then(() => {
                a.classList.remove("cm-wikilink-missing");
                a.classList.add("cm-wikilink-active");
                // update state so subsequent clicks don't re-create it
                exists = true;
                return invoke("open_path", { path: this.path });
              })
              .catch((err: any) => {
                a.classList.add("cm-wikilink-error");
                a.title = `Failed to create file: ${String(err)}`;
              });
          } else {
            // Cannot auto-create non-markdown assets
            a.classList.add("cm-wikilink-error");
            a.title = "파일이 존재하지 않습니다 (마크다운 파일만 자동 생성 가능)";
          }
        }
      });
    });

    // Alt+click → edit the raw [[wikilink]]
    a.addEventListener("mousedown", (e) => {
      if (!e.altKey) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(a) } });
    });
    return a;
  }
  ignoreEvent() {
    return true;
  }
}
