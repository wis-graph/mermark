import { EditorView, ViewPlugin } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

// ---------------------------------------------------------------------------
// Footnote bidirectional click navigation. Clicking a reference chip `[^name]`
// jumps to its definition `[^name]:`; clicking a definition marker jumps to the
// first reference (a back-link). Both directions scroll + place the caret, in
// read and edit mode. Same-document only — no baseDir/filePath needed.
//
// This lives next to inlinePreview as a capture-phase mousedown listener (the
// same shape as core.ts's clickEntry). It runs BEFORE CM's default caret
// placement and stops the event so reveal/caret logic doesn't fight the jump.
// Alt+click is the escape hatch (edit the raw `[^name]`), matching wikilink.ts.
// ---------------------------------------------------------------------------

/** Escape a footnote label so it can be embedded literally in a RegExp. */
export function escapeLabel(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a line is a footnote definition for `label` (`[^label]:` at line
 *  start). The `:` immediately after the closing `]` is what distinguishes a
 *  definition from a bare reference. */
function isDefinitionLine(text: string, label: string): boolean {
  return new RegExp(`^\\[\\^${escapeLabel(label)}\\]:`).test(text);
}

/**
 * Position of the first definition `[^label]:` marker (its `[`), or null if the
 * document has no definition for `label`. Pure: scans the doc, no side effects.
 */
export function findFootnoteDef(state: EditorState, label: string): number | null {
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (isDefinitionLine(line.text, label)) return line.from;
  }
  return null;
}

/**
 * Position of the first reference `[^label]` that is NOT a definition (so a
 * definition's own `[^label]:` is never treated as its own back-link target),
 * or null if there is no such reference. Pure: scans the doc, no side effects.
 */
export function findFootnoteRef(state: EditorState, label: string): number | null {
  const marker = `[^${label}]`;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (isDefinitionLine(line.text, label)) continue; // a def line is not a ref
    const col = line.text.indexOf(marker);
    if (col !== -1) return line.from + col;
  }
  return null;
}

/** Label of the reference whose source starts at `pos` (`[^label]`), or null. */
function labelAtRef(state: EditorState, pos: number): string | null {
  const m = /^\[\^([^\]]+)\]/.exec(state.sliceDoc(pos, pos + 256));
  return m ? m[1] : null;
}

/** Label of the definition on the line containing `pos` (`[^label]:`), or null. */
function labelAtDef(state: EditorState, pos: number): string | null {
  const m = /^\[\^([^\]]+)\]:/.exec(state.doc.lineAt(pos).text);
  return m ? m[1] : null;
}

/** Scroll to `target`, put the caret there, and focus — the shared landing. */
function jumpTo(view: EditorView, target: number): void {
  view.dispatch({
    selection: { anchor: target },
    effects: EditorView.scrollIntoView(target, { y: "center" }),
    scrollIntoView: true,
  });
  view.focus();
}

/**
 * Resolve the navigation target for a footnote mousedown, or null if the click
 * was not on a footnote (or has no counterpart). Pure query over the DOM event.
 */
function resolveTarget(view: EditorView, target: HTMLElement): number | null {
  const ref = target.closest(".cm-footnote-ref") as HTMLElement | null;
  if (ref) {
    const label = labelAtRef(view.state, view.posAtDOM(ref));
    return label === null ? null : findFootnoteDef(view.state, label);
  }
  const def = target.closest(".cm-footnote-def-marker") as HTMLElement | null;
  if (def) {
    const label = labelAtDef(view.state, view.posAtDOM(def));
    return label === null ? null : findFootnoteRef(view.state, label);
  }
  return null;
}

/** Capture-phase footnote click navigation. Add next to inlinePreview. */
export const footnoteNav = ViewPlugin.fromClass(
  class {
    readonly onDown: (e: MouseEvent) => void;
    constructor(readonly view: EditorView) {
      this.onDown = (e) => {
        if (e.altKey) return; // Alt+click = edit the raw [^name], not navigate
        const target = resolveTarget(view, e.target as HTMLElement);
        if (target === null) return; // not a footnote, or no counterpart → no-op
        e.preventDefault();
        e.stopPropagation();
        jumpTo(view, target);
      };
      view.dom.addEventListener("mousedown", this.onDown, true);
    }
    destroy() {
      this.view.dom.removeEventListener("mousedown", this.onDown, true);
    }
  },
);
