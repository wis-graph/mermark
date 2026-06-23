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

/** Scroll `target` to the viewport center and place the caret there (one
 *  transaction). The transaction-level `scrollIntoView: true` flag is *not* set:
 *  in a single transaction CM processes that flag first and then lets an explicit
 *  `scrollIntoView` effect overwrite it, so the flag is a redundant no-op that
 *  only muddies intent ("center" + "nearest" in one breath). Command, void. */
export function scrollTargetToCenter(view: EditorView, target: number): void {
  view.dispatch({
    selection: { anchor: target },
    effects: EditorView.scrollIntoView(target, { y: "center" }),
  });
}

// How long to keep re-centering after the first scroll. A forward jump crosses
// async live-preview widgets (mermaid: import()+render+rAF; KaTeX: import()+
// .then) whose final height isn't known when the first scroll is applied —
// mermaid in particular settles several frames later. So we keep re-centering on
// each animation frame for a bounded window, and immediately when a diagram fires
// `mermaid-rendered`. The whole thing is convergent (each pass is idempotent:
// once layout is stable the target is already centered, so the dispatch is a
// no-op scroll) and self-terminating (the window closes after SETTLE_WINDOW_MS),
// so there is no infinite re-center loop. Named constant, not a setting.
const SETTLE_WINDOW_MS = 1200;

/** Re-center `target` after async live-preview widgets settle their height — the
 *  domain rule that fixes forward footnote landing.
 *
 *  WHY this exists: a forward jump (reference → definition below) scrolls *past*
 *  not-yet-measured async widgets (mermaid / KaTeX). CM computes the scroll
 *  position from the height map's *estimate* of those blocks, applies it once,
 *  and then discards the scroll target — it never re-centers when the real
 *  heights arrive. So the definition ends up off-center. Backward jumps go *up*
 *  into already-rendered, already-measured space and are unaffected; this helper
 *  is shared by both directions and re-centering is idempotent, so backward
 *  never regresses (it just re-applies the same, already-correct center).
 *
 *  WHY animation frames (not requestMeasure): the re-center must `dispatch`, and
 *  a transaction can't be dispatched from inside CM's measure `write` phase
 *  ("Calls to EditorView.update are not allowed while an update is in progress").
 *  rAF callbacks run *outside* the update cycle, so dispatching there is safe —
 *  and rAF is also when async widgets have just laid out. We re-center once per
 *  frame across a bounded settle window, plus the moment `mermaid-rendered`
 *  bubbles up (a diagram below the target can finish after the window). All
 *  timers and listeners are torn down when the window closes — no leak, no
 *  infinite loop. Command, void. */
export function recenterAfterAsyncLayout(view: EditorView, target: number): void {
  // Re-center only — no `selection`. The caret was already placed by the initial
  // scrollTargetToCenter; re-asserting it every frame would re-grab the caret if
  // the user clicked elsewhere while widgets settle. This pass adjusts scroll, not
  // selection, which is also what makes it safely idempotent for backward jumps.
  const recenter = () =>
    view.dispatch({ effects: EditorView.scrollIntoView(target, { y: "center" }) });

  let raf = 0;
  const deadline = Date.now() + SETTLE_WINDOW_MS;
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    view.scrollDOM.removeEventListener("mermaid-rendered", recenter);
  };
  const tick = () => {
    recenter();
    if (Date.now() >= deadline) return stop();
    raf = requestAnimationFrame(tick);
  };
  // A diagram below the target can finish rendering after the settle window; an
  // explicit re-center on its event closes that gap without widening the window.
  view.scrollDOM.addEventListener("mermaid-rendered", recenter);
  raf = requestAnimationFrame(tick);
}

/** Scroll to `target`, put the caret there, and focus — the shared landing.
 *  Centers immediately, then keeps the target centered as async widgets settle
 *  (see recenterAfterAsyncLayout). Command, void. */
export function jumpTo(view: EditorView, target: number): void {
  scrollTargetToCenter(view, target);
  view.focus();
  recenterAfterAsyncLayout(view, target);
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
