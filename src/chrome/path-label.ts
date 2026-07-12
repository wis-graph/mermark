// ---------------------------------------------------------------------------
// Shared "left-truncating path" DOM builder — renders a path so its
// RIGHTMOST (most identifying) segment stays visible when the containing
// row clips text with an ellipsis. Used by both the favorites section
// (favorites-panel.ts) and the recent-documents panel (recent-panel.ts).
//
// Consolidated 2026-07-03 (docs/reviews/intent-review-2026-07-03.md #1) from
// two byte-identical DOM-construction copies (M4 favorites-panel.ts, cloned
// into recent-panel.ts at M6 — the CSS comment there admitted the clone).
// Both callers now build this DOM through `truncatedPathLabel` instead of
// inlining `<span class="…-path"><bdi>…</bdi></span>` themselves.
//
// The trick is CSS-only (styles.css `.path-label`): `direction: rtl` flips
// WHERE the ellipsis clips (the start, not the end) while `text-align:
// left` keeps the text visually left-anchored. The `<bdi>` isolates the
// path's own LTR segment order from that rtl flip, so
// "/Users/x/work/projects" still reads left-to-right and only clips from
// the left edge. No JS width measurement — zoom-guard/sash-resize friendly
// for free.
// ---------------------------------------------------------------------------

import { basename } from "../path";

/** `<span class="path-label"><bdi>path</bdi></span>` — the single DOM
 *  builder for the left-truncating path label. Callers append the result
 *  next to a basename headline; they never construct the bdi/rtl structure
 *  inline (that was the duplication this module removes). Pure query (CQS):
 *  builds and returns a detached element, no side effects. */
export function truncatedPathLabel(path: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "path-label";
  const bdi = document.createElement("bdi");
  bdi.textContent = path;
  el.append(bdi);
  return el;
}

/** Whether a path's label row would duplicate the name headline right above
 *  it: true when the path has NO directory component, so its basename IS the
 *  whole path (e.g. a bare "x.md" opened from the CLI, or a favorited folder
 *  passed in already-bare). Callers gate their truncatedPathLabel() append on
 *  `!redundantPathLabel(path)` instead of always rendering a second line that
 *  repeats the name verbatim. Pure query. */
export function redundantPathLabel(path: string): boolean {
  return basename(path) === path;
}
