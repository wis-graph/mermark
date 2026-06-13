import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, highlightActiveLine } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { blockPreview, inlinePreview, modeFacet, refreshBlocks, type PreviewMode } from "./markdown/live-preview";
import { markdownFolding } from "./markdown/fold";
import { markdownLang } from "./markdown/parser";

const SAVE_DEBOUNCE_MS = 500;

export type SaveStatus = "saved" | "saving" | "error";
export type { PreviewMode };

export interface EditorController {
  view: EditorView;
  mode(): PreviewMode;
  setMode(m: PreviewMode): void;
  toggleMode(): void;
  /** Force block widgets (mermaid) to re-render — used after a live theme change. */
  refresh(): void;
}

/** Debounced autosave to disk; flush() writes any pending change immediately
 *  (used when leaving edit mode so a mode switch never loses work). */
function makeAutosave(path: string, onStatus: (s: SaveStatus, detail?: string) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | null = null;
  const write = (text: string) => {
    invoke("write_file", { path, text })
      .then(() => onStatus("saved"))
      .catch((err) => onStatus("error", String(err)));
  };
  return {
    extension: EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      onStatus("saving");
      pending = u.state.doc.toString();
      clearTimeout(timer);
      timer = setTimeout(() => {
        const text = pending;
        pending = null;
        if (text !== null) write(text);
      }, SAVE_DEBOUNCE_MS);
    }),
    flush() {
      if (pending === null) return;
      clearTimeout(timer);
      const text = pending;
      pending = null;
      write(text);
    },
  };
}

function modeExtensions(mode: PreviewMode) {
  return [
    modeFacet.of(mode),
    EditorView.editable.of(mode === "edit"),
    EditorState.readOnly.of(mode === "read"),
    // keep the content focusable in read mode so Mod-e still toggles back
    EditorView.contentAttributes.of({ tabindex: "0" }),
    // mark the cursor's line only while editing (read mode has no caret to track)
    ...(mode === "edit" ? [highlightActiveLine()] : []),
  ];
}

export function mountEditor(
  parent: HTMLElement,
  doc: string,
  baseDir: string,
  filePath: string,
  opts: {
    onStatus?: (s: SaveStatus, detail?: string) => void;
    initialMode?: PreviewMode;
    onMode?: (m: PreviewMode) => void;
    onCursor?: (line: number, col: number) => void;
  } = {},
): EditorController {
  const { onStatus = () => {}, initialMode = "read", onMode = () => {}, onCursor = () => {} } = opts;
  const autosave = makeAutosave(filePath, onStatus);
  const modeCompartment = new Compartment();
  let mode: PreviewMode = initialMode;

  const controller: EditorController = {
    view: null as unknown as EditorView,
    mode: () => mode,
    setMode(m: PreviewMode) {
      if (m === mode) return;
      if (mode === "edit") autosave.flush(); // leaving edit = save point
      mode = m;
      controller.view.dispatch({ effects: modeCompartment.reconfigure(modeExtensions(m)) });
      onMode(m);
    },
    toggleMode() {
      controller.setMode(mode === "edit" ? "read" : "edit");
    },
    refresh() {
      controller.view.dispatch({ effects: refreshBlocks.of(null) });
    },
  };

  const state = EditorState.create({
    doc,
    extensions: [
      markdownLang(),
      markdownFolding,
      inlinePreview(baseDir, filePath),
      blockPreview,
      modeCompartment.of(modeExtensions(initialMode)),
      history(),
      keymap.of([
        { key: "Mod-e", run: () => (controller.toggleMode(), true) },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      autosave.extension,
      EditorView.updateListener.of((u) => {
        if (!u.selectionSet && !u.docChanged) return;
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        onCursor(line.number, head - line.from + 1);
      }),
      EditorView.lineWrapping,
    ],
  });
  controller.view = new EditorView({ state, parent });
  return controller;
}
