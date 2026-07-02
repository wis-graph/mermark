import { EditorView, WidgetType } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { openPath as openAsset } from "@tauri-apps/plugin-opener";
import { findHeadingByText } from "./outline";
import { jumpTo } from "./footnote-nav";

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

/**
 * Whether `target` is a same-file heading anchor (bare `#Heading`, no file
 * part), and if so, the heading text to search for. The "same-file heading
 * anchor" definition in ONE place — everything downstream (the widget's click
 * handler) trusts this instead of re-parsing `#`.
 *   "#Sec"      -> "Sec"   (bare anchor)
 *   "file#Sec"  -> null    (has a file part — cross-file, out of scope; see
 *                           wikilinkPath, which stays the file-open path)
 *   "#^abc123"  -> null    (block reference, not a heading — preserved as-is)
 *   "#" / ""    -> null    (empty anchor / no anchor at all)
 * Pure query.
 */
export function sameFileHeadingAnchor(target: string): string | null {
  const hashIdx = target.indexOf("#");
  if (hashIdx === -1) return null; // no anchor at all
  const file = target.slice(0, hashIdx).trim();
  if (file !== "") return null; // has a file part -> cross-file, out of scope
  const anchor = target.slice(hashIdx + 1).trim();
  if (anchor === "" || anchor.startsWith("^")) return null; // empty, or a block ref
  return anchor;
}

/** Alt+click escape hatch: edit the raw `[[wikilink]]` instead of navigating or
 *  opening. Attached to EVERY toDOM branch (heading anchor, same-file-with-no-
 *  currentFile, and file-open) so Alt+click always means "reveal source"
 *  regardless of what the link resolves to — one shared rule, not re-attached
 *  ad hoc per branch. Command, void. */
function attachAltClickEdit(a: HTMLAnchorElement, view: EditorView): void {
  a.addEventListener("mousedown", (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    view.dispatch({ selection: { anchor: view.posAtDOM(a) } });
  });
}

export class WikilinkWidget extends WidgetType {
  constructor(
    readonly alias: string,
    readonly path: string,
    readonly headingAnchor: string | null = null,
  ) {
    super();
  }
  eq(o: WikilinkWidget) {
    return o.path === this.path && o.alias === this.alias && o.headingAnchor === this.headingAnchor;
  }
  toDOM(view: EditorView) {
    const a = document.createElement("a");
    a.className = "cm-wikilink cm-wikilink-pending";
    a.textContent = this.alias;

    if (this.headingAnchor !== null) {
      // [[#heading]] — same-file heading jump. No IPC: the target is resolved
      // against the LIVE document at click time (not render time), so edits
      // made after the widget was drawn still land correctly.
      a.classList.remove("cm-wikilink-pending");
      a.classList.add("cm-wikilink-active");
      a.addEventListener("click", (e) => {
        if (e.altKey) return; // Alt+click = edit the raw [[#heading]] (attachAltClickEdit), not jump
        e.preventDefault();
        const pos = findHeadingByText(view.state, this.headingAnchor!);
        if (pos === null) {
          a.title = "헤딩을 찾을 수 없습니다";
          return; // graceful no-op — no matching heading in the current document
        }
        a.removeAttribute("title"); // clear a stale "not found" tooltip if this widget's DOM was reused
        jumpTo(view, pos);
      });
      attachAltClickEdit(a, view);
      return a;
    }

    if (!this.path) {
      // same-file anchor with nothing resolvable (e.g. currentFile unset) —
      // nothing to open.
      a.classList.remove("cm-wikilink-pending");
      a.classList.add("cm-wikilink-active");
      attachAltClickEdit(a, view);
      return a;
    }

    const isMd = isMarkdownPath(this.path);
    let fileExists: boolean | null = null;

    a.addEventListener("click", (e) => {
      e.preventDefault();
      if (fileExists === null) return; // ignore clicks while checking path existence

      if (fileExists) {
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
              fileExists = true; // update state so subsequent clicks don't re-create it
              return invoke("open_path", { path: this.path }).catch((err: any) => {
                a.classList.add("cm-wikilink-error");
                a.title = `Failed to open file: ${String(err)}`;
              });
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

    invoke<boolean>("path_exists", { path: this.path }).then((exists) => {
      fileExists = exists;
      a.classList.remove("cm-wikilink-pending");
      a.classList.add(exists ? "cm-wikilink-active" : "cm-wikilink-missing");
    });

    attachAltClickEdit(a, view);
    return a;
  }
  ignoreEvent() {
    return true;
  }
}
