import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Keys that wrap a selection in a markdown mark, and how one press transitions
 *  the symmetric run of that char already hugging the selection:
 *   - `=` toggles highlight: 0 ↔ 2  (`x` ↔ `==x==`); `=x=` isn't valid markdown,
 *     so one press gives the full `==` mark and the next press removes it.
 *   - `*` cycles emphasis: 0→1→2→3→0  (`x` → `*x*` italic → `**x**` bold →
 *     `***x***` bold-italic → `x`), so repeated presses reach every level.
 *  Over an EMPTY selection the key types literally (so `a = b` / `2 * 3` are
 *  untouched). `max` caps how deep the surrounding run is inspected. */
const MARKERS: Record<string, { max: number; next: (cur: number) => number }> = {
  "=": { max: 2, next: (c) => (c >= 2 ? 0 : 2) },
  "*": { max: 3, next: (c) => (c >= 3 ? 0 : c + 1) },
};

/** Length of the run of `ch` immediately left of `pos` (exclusive), capped at `max`. */
function runBefore(state: EditorState, pos: number, ch: string, max: number): number {
  let n = 0;
  while (n < max && pos - n - 1 >= 0 && state.sliceDoc(pos - n - 1, pos - n) === ch) n++;
  return n;
}

/** Length of the run of `ch` immediately right of `pos` (inclusive), capped at `max`. */
function runAfter(state: EditorState, pos: number, ch: string, max: number): number {
  let n = 0;
  const len = state.doc.length;
  while (n < max && pos + n + 1 <= len && state.sliceDoc(pos + n, pos + n + 1) === ch) n++;
  return n;
}

/** Build the transaction for pressing `ch` with the current selection: for each
 *  non-empty range, read the symmetric run of `ch` already hugging it, compute
 *  the next level (toggle for `=`, cycle for `*`), and rewrite the marks while
 *  keeping the inner text selected (so a re-press reads the new run and advances).
 *  Empty ranges take a literal `ch`. Returns `null` when nothing is selected —
 *  the input handler's signal to let the key type normally. Pure query. */
export function buildMarkupWrap(state: EditorState, ch: string): TransactionSpec | null {
  const marker = MARKERS[ch];
  if (!marker) return null;
  if (state.selection.ranges.every((r) => r.empty)) return null;
  return state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: ch },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const cur = Math.min(
      runBefore(state, range.from, ch, marker.max),
      runAfter(state, range.to, ch, marker.max),
    );
    const level = marker.next(cur);
    const inner = state.sliceDoc(range.from, range.to);
    const mark = ch.repeat(level);
    const from = range.from - cur; // strip the existing symmetric run…
    const to = range.to + cur;
    const innerFrom = from + level; // …then re-mark at the new level
    return {
      changes: { from, to, insert: `${mark}${inner}${mark}` },
      range: EditorSelection.range(innerFrom, innerFrom + inner.length),
    };
  });
}

/** Editor extension: pressing `=` / `*` over a selection wraps (or cycles) the
 *  markdown mark around it — `==highlight==`, and `*italic*`→`**bold**`→
 *  `***both***`. With no selection the key types normally. The `==`/doubled
 *  forms are why closeBrackets (single open/close pairs) can't do this. */
export function markupWrap() {
  return EditorView.inputHandler.of((view, _from, _to, text) => {
    if (!(text in MARKERS)) return false;
    const spec = buildMarkupWrap(view.state, text);
    if (spec === null) return false; // nothing selected → let the key type normally
    view.dispatch(view.state.update(spec, { scrollIntoView: true, userEvent: "input.type" }));
    return true;
  });
}
