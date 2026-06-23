import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, highlightActiveLine, drawSelection } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { invoke } from "@tauri-apps/api/core";
import { blockPreview, inlinePreview, modeFacet, refreshBlocks, type PreviewMode } from "./markdown/live-preview";
import { footnoteNav } from "./markdown/footnote-nav";
import { footnoteHover } from "./markdown/footnote-hover";
import { markdownFolding } from "./markdown/fold";
import { markdownLang } from "./markdown/parser";
import { wikilinkCompletionSource } from "./markdown/wikilink-complete";
import { markupWrap } from "./markdown/markup-wrap";
import { pasteLinkWrap } from "./markdown/paste-link";
import type { ConflictPolicy, VimMode } from "./settings/app";

export type SaveStatus = "saved" | "saving" | "error" | "conflict";
export type { PreviewMode };

function vimExtensions(vimEnabled: boolean) {
  return vimEnabled ? [vim()] : [];
}

/** Default autosave debounce used when the caller threads no delay (e.g. tests
 *  that mount without opts). The live value flows from autosaveDelaySetting. */
const DEFAULT_AUTOSAVE_DELAY_MS = 800;

/** The conflict-resolution rule in one named place: should a refused write
 *  (the file changed on disk) clobber the external change with the user's
 *  buffer? `overwrite` says yes (data-loss risk, opt-in); `pause` (default)
 *  says no — keep the buffer, halt autosave, rescue on close. Pure (CQS). */
export function shouldOverwriteOnConflict(policy: ConflictPolicy): boolean {
  return policy === "overwrite";
}

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
  /** Live autosave-debounce sink: the new delay applies from the NEXT debounce
   *  (already-scheduled timers keep their delay, so no keystroke is lost). */
  setAutosaveDelay(ms: number): void;
  /** Live conflict-policy sink: pause (keep buffer) vs overwrite (clobber the
   *  external change). Read at conflict time, so a change applies to the next
   *  refused write. */
  setConflictPolicy(p: ConflictPolicy): void;
  setVimMode(enabled: boolean): void;
  reloadFromFile(text: string, mtime: number): void;
}

/** Debounced autosave to disk. Tracks the file's modification time as a baseline
 *  so the backend can refuse to clobber an external change (`conflict` status).
 *  While conflicted it stops hammering the disk but keeps tracking the buffer, so
 *  the close path can still rescue unsaved edits. */
function makeAutosave(
  path: string,
  baseMtime: number,
  onStatus: (s: SaveStatus, detail?: string) => void,
  getDelay: () => number,
  getPolicy: () => ConflictPolicy,
) {
  const recoveryPath = `${path}.mermark-recovered`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | null = null;
  let baseline = baseMtime;
  let conflicted = false; // a disk write was refused; autosave paused until resolved
  let closing = false; // window is closing; stop accepting new autosave work
  let inFlight: Promise<void> | null = null;

  /** The debounce in effect right now (read live so a settings change applies
   *  from the next debounce — already-scheduled timers keep their delay). */
  const currentDelay = (): number => getDelay();

  /** Overwrite the file with `text` at baseline 0 (discard the external change),
   *  re-arming autosave. Shared by the conflict `overwrite` policy and the
   *  manual force-save button so the clobber-and-rebaseline rule lives once. */
  const overwriteOnDisk = (text: string): Promise<void> => {
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
    return p;
  };

  /** Persist `text` to the file, honoring the conflict guard. On a refused
   *  write the conflict policy decides: `overwrite` clobbers the external
   *  change immediately; `pause` (default) halts autosave and waits. */
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
          if (shouldOverwriteOnConflict(getPolicy())) {
            overwriteOnDisk(text); // policy: discard the external change
            return;
          }
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
      }, currentDelay());
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
      clearTimeout(timer); // absorb any scheduled debounce so it can't fire a duplicate write
      pending = null;
      onStatus("saving");
      overwriteOnDisk(text);
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
      // Conflicted on the way out. The overwrite policy clobbers the external
      // change (discard it); pause (default) parks the buffer beside the file so
      // neither side is lost.
      if (shouldOverwriteOnConflict(getPolicy())) {
        try {
          const mtime = await invoke<number>("write_file", { path, text, baseline: 0 });
          if (typeof mtime === "number" && mtime > 0) baseline = mtime;
          onStatus("saved");
        } catch (err) {
          onStatus("error", String(err));
        }
        return;
      }
      try {
        await invoke("write_file", { path: recoveryPath, text, baseline: 0 });
        onStatus("conflict", `편집 내용을 ${recoveryPath} 에 보존했습니다`);
      } catch (err) {
        onStatus("error", String(err));
      }
    },
    resetBaseline(mtime: number) {
      baseline = mtime;
      conflicted = false;
      pending = null;
      onStatus("saved");
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
    /** Initial autosave debounce in ms (live value flows via setAutosaveDelay). */
    autosaveDelay?: number;
    /** Initial conflict policy (live value flows via setConflictPolicy). */
    conflictPolicy?: ConflictPolicy;
    vimMode?: VimMode;
  } = {},
): EditorController {
  const {
    onStatus = () => {},
    initialMode = "read",
    onToggleMode = () => {},
    onCursor = () => {},
    baseMtime = 0,
    autosaveDelay = DEFAULT_AUTOSAVE_DELAY_MS,
    conflictPolicy = "pause",
  } = opts;
  // The SSOT settings are the writers; these mutable cells are the editor's sink
  // for them. makeAutosave reads them live via getters so a settings change
  // reaches in-flight behavior without re-creating the autosave controller.
  let delay = autosaveDelay;
  let policy: ConflictPolicy = conflictPolicy;
  const autosave = makeAutosave(
    filePath,
    baseMtime,
    onStatus,
    () => delay,
    () => policy,
  );
  const modeCompartment = new Compartment();
  const vimCompartment = new Compartment();
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
    setAutosaveDelay(ms: number) {
      delay = ms;
    },
    setConflictPolicy(p: ConflictPolicy) {
      policy = p;
    },
    setVimMode(enabled: boolean) {
      controller.view.dispatch({ effects: vimCompartment.reconfigure(vimExtensions(enabled)) });
    },
    reloadFromFile(text: string, mtime: number) {
      controller.view.dispatch({
        changes: { from: 0, to: controller.view.state.doc.length, insert: text }
      });
      autosave.resetBaseline(mtime);
    },
  };

  const state = EditorState.create({
    doc,
    extensions: [
      markdownLang(),
      markdownFolding,
      inlinePreview(baseDir, filePath),
      blockPreview,
      // Footnote click navigation: ref chip → definition, def marker → first
      // reference. Capture-phase mousedown (like core's clickEntry); same
      // document, so no baseDir/filePath needed.
      footnoteNav,
      // Footnote hover preview: ⌘/Ctrl + mouseover a ref chip pops a small
      // floating card with the definition text. Read-only overlay (no dispatch,
      // no preventDefault), so it coexists with footnoteNav's mousedown.
      footnoteHover,
      // input-UX layer (not decoration): auto-close brackets and the [[ file
      // picker. Defaults are fine; closeBrackets gives [→[], [[→[[]], overtype,
      // and selection-wrap. The completion source owns the `[[ ]]` flow.
      // markupWrap is the doubled-mark analogue: `=` over a selection toggles
      // ==highlight==, `*` cycles *italic*→**bold**→***both***.
      markupWrap(),
      // Paste a URL over a non-empty selection → wrap it as [selection](url)
      // (Obsidian-style auto-linking). Falls back to a normal paste otherwise.
      pasteLinkWrap(),
      closeBrackets(),
      autocompletion({ override: [wikilinkCompletionSource(baseDir)], activateOnTyping: true }),
      modeCompartment.of(modeExtensions(initialMode)),
      vimCompartment.of(vimExtensions(opts.vimMode === "on")),
      history(),
      // closeBrackets/completion keymaps sit before defaultKeymap so an active
      // popup grabs Enter/Tab first; both pass through when no popup is open, so
      // default Enter/Tab and the app's Mod-chord shortcuts are untouched.
      keymap.of([
        { key: "Mod-e", run: () => (onToggleMode(), true) },
        ...closeBracketsKeymap,
        ...completionKeymap,
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
      // Render the EditorState selection as CM's own .cm-selectionBackground
      // overlay layer instead of relying on the browser's native DOM ::selection.
      // Vim's hideNativeSelection (Prec.highest) forces .cm-vimMode ::selection
      // transparent, and vim sets visual-mode ranges programmatically as
      // EditorState selection — with no native selection to paint, the highlight
      // was invisible. This base layer (outside the vim compartment, always on)
      // gives every selection range a paintable layer: vim visual mode, edit-mode
      // drag, and multi-cursor all draw here. Styled via --selection-bg in
      // styles.css. Measure-inert overlay — it never touches .cm-content/.cm-line
      // font-size, so the ⌘± zoom guard holds.
      drawSelection(),
    ],
  });
  controller.view = new EditorView({ state, parent });
  return controller;
}
