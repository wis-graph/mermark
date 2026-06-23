import { EditorView, ViewPlugin } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { findFootnoteDef, escapeLabel } from "./footnote-nav";

// ---------------------------------------------------------------------------
// Footnote hover preview. Holding ⌘ (or Ctrl) while the pointer is over a
// reference chip `[^name]` pops a small floating card showing the matching
// definition `[^name]:` — the Obsidian note/link hover feel. This is a sibling
// to footnoteNav (footnote-nav.ts): same shape (a ViewPlugin that wires DOM
// listeners and tears them down in destroy()), but it listens to pointer/key
// events instead of mousedown, never dispatches, and never preventDefaults —
// so it's a read-only overlay that can't fight the click-navigation path.
//
// The popup is a single reused <div> mounted under view.dom (outside
// .cm-content), so it's exempt from the ZOOM GUARD — its font is a fixed scale,
// not tied to .cm-content/.cm-line. Definition text is pulled by a pure query
// (footnoteDefinitionText); no document is ever mutated.
// ---------------------------------------------------------------------------

/** True when the preview gate is held: ⌘ on mac, Ctrl elsewhere. Mirrors the
 *  `e.metaKey || e.ctrlKey` shortcut convention in main.ts:347,360. */
export function isPreviewModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey;
}

/** Drop the `[^label]:` definition marker (and one optional following space)
 *  from the start of a definition line, leaving the definition's first line of
 *  text. `escapeLabel` keeps regex-special labels (`a.b*`) literal. */
function stripDefinitionMarker(lineText: string, label: string): string {
  return lineText.replace(new RegExp(`^\\[\\^${escapeLabel(label)}\\]:\\s?`), "");
}

/** True when a line continues the definition block above it: an indented,
 *  non-blank line (`^\s+\S`). A blank line, a new definition (`^[^`), or
 *  non-indented body text stops the block — none of those are continuations. */
function isContinuationLine(lineText: string): boolean {
  return /^\s+\S/.test(lineText);
}

/**
 * The full text of the first definition for `label` (the `[^label]:` line plus
 * any indented continuation lines), newlines preserved and trimmed — or null if
 * the document has no definition for `label` (so the popup is a no-op). Pure:
 * reads EditorState only, no side effects. Reuses findFootnoteDef so it never
 * re-scans for the definition position itself.
 */
export function footnoteDefinitionText(state: EditorState, label: string): string | null {
  const defAt = findFootnoteDef(state, label);
  if (defAt === null) return null;
  const defLine = state.doc.lineAt(defAt);
  const parts = [stripDefinitionMarker(defLine.text, label)];
  for (let n = defLine.number + 1; n <= state.doc.lines; n++) {
    const text = state.doc.line(n).text;
    if (!isContinuationLine(text)) break; // blank / new def / dedented body → stop
    parts.push(text.trim());
  }
  return parts.join("\n").trim();
}

/** Label of the reference chip whose replaced source `[^label]` starts at
 *  `pos`, or null. The chip is a Decoration.replace over `[^label]`, so its
 *  posAtDOM lands on the marker's `[`. */
function labelAtChip(state: EditorState, pos: number): string | null {
  const m = /^\[\^([^\]]+)\]/.exec(state.sliceDoc(pos, pos + 256));
  return m ? m[1] : null;
}

/** Position the popup just above or below the chip, flipping to whichever side
 *  has room in the viewport. position:fixed, so chip rect coords are used as-is
 *  (no scroll correction). Void command — mutates the popup element only. */
function placeAbove(el: HTMLDivElement, rect: DOMRect): void {
  const gap = 6;
  el.style.left = `${rect.left}px`;
  // Default below the chip; flip above when the lower half would overflow.
  const wouldOverflowBelow = rect.bottom + el.offsetHeight + gap > window.innerHeight;
  if (wouldOverflowBelow && rect.top - el.offsetHeight - gap >= 0) {
    el.style.top = `${rect.top - el.offsetHeight - gap}px`;
  } else {
    el.style.top = `${rect.bottom + gap}px`;
  }
}

/**
 * ⌘/Ctrl + hover preview for footnote reference chips. Sibling of footnoteNav;
 * register next to it. Read-only overlay: never dispatches, never preventDefaults.
 */
export const footnoteHover = ViewPlugin.fromClass(
  class {
    previewEl: HTMLDivElement | null = null;
    private shownLabel: string | null = null; // skip re-extract on same-chip mousemove
    private readonly onOver: (e: MouseEvent) => void;
    private readonly onMove: (e: MouseEvent) => void;
    private readonly onOut: (e: MouseEvent) => void;
    private readonly onKeyUp: (e: KeyboardEvent) => void;
    private readonly onScroll: () => void;
    private readonly onBlur: () => void;

    constructor(readonly view: EditorView) {
      const maybeShow = (e: MouseEvent) => {
        const chip = (e.target as HTMLElement | null)?.closest(".cm-footnote-ref") as HTMLElement | null;
        if (!chip || !isPreviewModifier(e)) {
          this.hidePreview();
          return;
        }
        const label = labelAtChip(view.state, view.posAtDOM(chip));
        if (label === null) return; // not over a resolvable chip → leave as-is
        const text = footnoteDefinitionText(view.state, label);
        if (text === null) {
          this.hidePreview();
          return; // no definition → no-op
        }
        this.showPreview(chip, label, text);
      };
      this.onOver = maybeShow;
      this.onMove = maybeShow;
      this.onOut = (e) => {
        // Leaving the chip for somewhere that is not (still) inside a chip.
        const to = e.relatedTarget as HTMLElement | null;
        if (!to || !to.closest(".cm-footnote-ref")) this.hidePreview();
      };
      this.onKeyUp = (e) => {
        if (!isPreviewModifier(e)) this.hidePreview(); // modifier released → close
      };
      this.onScroll = () => this.hidePreview(); // chip rect is stale after scroll
      this.onBlur = () => this.hidePreview();

      view.dom.addEventListener("mouseover", this.onOver);
      view.dom.addEventListener("mousemove", this.onMove);
      view.dom.addEventListener("mouseout", this.onOut);
      window.addEventListener("keyup", this.onKeyUp);
      window.addEventListener("blur", this.onBlur);
      view.scrollDOM.addEventListener("scroll", this.onScroll);
    }

    /** Lazily create + reuse the single popup, fill it, and place it by the chip
     *  rect. Void command. Idempotent for the same chip (skips re-place churn). */
    private showPreview(chip: HTMLElement, label: string, text: string): void {
      if (!this.previewEl) {
        const el = document.createElement("div");
        el.className = "cm-footnote-preview";
        this.view.dom.appendChild(el);
        this.previewEl = el;
      }
      if (this.shownLabel !== label || this.previewEl.style.display === "none") {
        this.previewEl.textContent = text;
        this.shownLabel = label;
      }
      this.previewEl.style.display = "block";
      placeAbove(this.previewEl, chip.getBoundingClientRect());
    }

    /** Hide the popup. Void command, idempotent. */
    private hidePreview(): void {
      if (this.previewEl) this.previewEl.style.display = "none";
      this.shownLabel = null;
    }

    destroy() {
      this.view.dom.removeEventListener("mouseover", this.onOver);
      this.view.dom.removeEventListener("mousemove", this.onMove);
      this.view.dom.removeEventListener("mouseout", this.onOut);
      window.removeEventListener("keyup", this.onKeyUp);
      window.removeEventListener("blur", this.onBlur);
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
      this.previewEl?.remove();
      this.previewEl = null;
    }
  },
);
