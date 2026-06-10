import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { blockPreview, inlinePreview } from "./markdown/decorate";
import { markdownLang } from "./markdown/parser";

const SAVE_DEBOUNCE_MS = 500;

export type SaveStatus = "saved" | "saving" | "error";

/** Debounced autosave to disk; reports status (incl. write errors) upward. */
function autosave(path: string, onStatus: (s: SaveStatus, detail?: string) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    onStatus("saving");
    clearTimeout(timer);
    timer = setTimeout(() => {
      invoke("write_file", { path, text: u.state.doc.toString() })
        .then(() => onStatus("saved"))
        .catch((err) => onStatus("error", String(err)));
    }, SAVE_DEBOUNCE_MS);
  });
}

export function mountEditor(
  parent: HTMLElement,
  doc: string,
  baseDir: string,
  filePath: string,
  onStatus: (s: SaveStatus, detail?: string) => void = () => {},
): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      markdownLang(),
      inlinePreview(baseDir, filePath),
      blockPreview,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      autosave(filePath, onStatus),
      EditorView.lineWrapping,
    ],
  });
  return new EditorView({ state, parent });
}
