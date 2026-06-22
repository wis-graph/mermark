import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, highlightActiveLine } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { blockPreview, inlinePreview, modeFacet, refreshBlocks, type PreviewMode } from "./markdown/live-preview";
import { markdownFolding } from "./markdown/fold";
import { markdownLang } from "./markdown/parser";

const SAVE_DEBOUNCE_MS = 500;

export type SaveStatus = "saved" | "saving" | "error" | "conflict";
export type { PreviewMode };

export interface EditorController {
  view: EditorView;
  mode(): PreviewMode;
  /** Apply a mode to the editor (SSOT sink): reconfigure CM and flush autosave
   *  when leaving edit. The setting is the writer; this only reacts. */
  setMode(m: PreviewMode): void;
  /** Force block widgets (mermaid) to re-render — used after a live theme change. */
  refresh(): void;
  /** True while an edit is buffered but not yet persisted to disk — including
   *  edits made after a conflict halted autosave. */
  hasUnsaved(): boolean;
  /** Overwrite the file even though it changed on disk (conflict recovery):
   *  keeps the user's buffer, discards the external change, re-arms autosave. */
  forceSave(): void;
  /** Stop accepting new autosave work — call before the close save so a
   *  late keystroke can't schedule a timer that the window close would orphan. */
  beginClose(): void;
  /** Persist the live buffer on the way out and resolve once it settles. Saves
   *  to the file normally; if the file changed on disk it writes a sibling
   *  `.mermark-recovered` instead, so neither the edits nor the external change
   *  are lost. Used by the window-close handler. */
  saveOnClose(): Promise<void>;
}

/** Debounced autosave to disk. Tracks the file's modification time as a baseline
 *  so the backend can refuse to clobber an external change (`conflict` status).
 *  While conflicted it stops hammering the disk but keeps tracking the buffer, so
 *  the close path can still rescue unsaved edits. */
function makeAutosave(
  path: string,
  baseMtime: number,
  onStatus: (s: SaveStatus, detail?: string) => void,
) {
  const recoveryPath = `${path}.mermark-recovered`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | null = null;
  let baseline = baseMtime;
  let conflicted = false; // a disk write was refused; autosave paused until resolved
  let closing = false; // window is closing; stop accepting new autosave work
  let inFlight: Promise<void> | null = null;

  /** Persist `text` to the file, honoring the conflict guard. */
  const save = (text: string): Promise<void> => {
    const p = invoke<number>("write_file", { path, text, baseline })
      .then((mtime) => {
        if (typeof mtime === "number" && mtime > 0) baseline = mtime;
        conflicted = false;
        onStatus("saved");
      })
      .catch((err) => {
        const msg = String(err);
        if (msg.startsWith("CONFLICT")) {
          conflicted = true;
          onStatus("conflict", msg);
        } else {
          onStatus("error", msg);
        }
      })
      .finally(() => {
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
    return p;
  };

  return {
    extension: EditorView.updateListener.of((u) => {
      if (!u.docChanged || closing) return;
      pending = u.state.doc.toString(); // always track the latest buffer
      if (conflicted) return; // don't keep hitting a file that changed under us
      onStatus("saving");
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (closing || conflicted) return;
        const text = pending;
        pending = null;
        if (text !== null) save(text);
      }, SAVE_DEBOUNCE_MS);
    }),
    /** Save the buffered edit now (leaving edit mode). No-op while conflicted —
     *  the buffer stays put and is rescued on close or via forceSave. */
    flush() {
      if (pending === null || conflicted) return;
      clearTimeout(timer);
      const text = pending;
      pending = null;
      save(text);
    },
    hasWork: () => pending !== null || inFlight !== null,
    forceSave(text: string) {
      clearTimeout(timer);
      pending = null;
      onStatus("saving");
      const p = invoke<number>("write_file", { path, text, baseline: 0 })
        .then((mtime) => {
          if (typeof mtime === "number" && mtime > 0) baseline = mtime;
          conflicted = false;
          onStatus("saved");
        })
        .catch((err) => onStatus("error", String(err)))
        .finally(() => {
          if (inFlight === p) inFlight = null;
        });
      inFlight = p;
    },
    beginClose() {
      closing = true;
      clearTimeout(timer);
    },
    async saveOnClose(text: string): Promise<void> {
      clearTimeout(timer);
      pending = null;
      if (!conflicted) {
        try {
          const mtime = await invoke<number>("write_file", { path, text, baseline });
          if (typeof mtime === "number" && mtime > 0) baseline = mtime;
          onStatus("saved");
          return;
        } catch (err) {
          // A fresh external change can surface only now — fall through to rescue.
          if (!String(err).startsWith("CONFLICT")) {
            onStatus("error", String(err));
            return;
          }
        }
      }
      // Conflicted: don't clobber the file. Park the buffer beside it instead.
      try {
        await invoke("write_file", { path: recoveryPath, text, baseline: 0 });
        onStatus("conflict", `편집 내용을 ${recoveryPath} 에 보존했습니다`);
      } catch (err) {
        onStatus("error", String(err));
      }
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
    onToggleMode?: () => void;
    onCursor?: (line: number, col: number) => void;
    /** Modification time observed when `doc` was read — the autosave baseline. */
    baseMtime?: number;
  } = {},
): EditorController {
  const {
    onStatus = () => {},
    initialMode = "read",
    onToggleMode = () => {},
    onCursor = () => {},
    baseMtime = 0,
  } = opts;
  const autosave = makeAutosave(filePath, baseMtime, onStatus);
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
    },
    refresh() {
      controller.view.dispatch({ effects: refreshBlocks.of(null) });
    },
    hasUnsaved: () => autosave.hasWork(),
    forceSave() {
      autosave.forceSave(controller.view.state.doc.toString());
    },
    beginClose: () => autosave.beginClose(),
    saveOnClose: () => autosave.saveOnClose(controller.view.state.doc.toString()),
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
        { key: "Mod-e", run: () => (onToggleMode(), true) },
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
