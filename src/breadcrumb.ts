import { breadcrumbSegments } from "./path";

// ---------------------------------------------------------------------------
// Footer BREADCRUMB — plain DOM chrome, same shape as recent-panel.ts /
// outline-panel.ts (injected handlers, single delegated listener). Mounts
// inside `.status-bar` (a sibling of the editor host under #app), never
// inside `.cm-content`/`.cm-line`, so it makes ZERO block/inline decorations
// — no intersection with the live-preview pipeline or the ⌘± zoom measure
// guard (the footer sits outside the editor's measure tree).
//
// This is a pure SINK: render(root) derives everything from breadcrumbSegments
// (a pure query), so the breadcrumb never drifts from its own rendering logic.
// Its SSOT is "the root explorer last rendered" — main wires that up via
// explorer.onRootChange + an openInWindow seed; this module only renders
// whatever root it's given and reports clicks upward via onJump.
// ---------------------------------------------------------------------------

export interface Breadcrumb {
  /** Footer-left, full-width container. Slot into StatusBarParts.breadcrumb
   *  (arrangeStatusBar owns the position; this owns the content). */
  readonly el: HTMLElement;
  /** Re-render for a new root. Pure w.r.t. DOM state — always replaces
   *  children (no accumulation across calls). `""` clears the breadcrumb.
   *  Command (void). */
  render(root: string): void;
}

export interface BreadcrumbHandlers {
  /** A segment was clicked — jump to that ancestor's REAL absolute path.
   *  Injected so this module reuses main's explorer.jumpToRoot with no new
   *  navigation code of its own. */
  onJump(absPath: string): void;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

export function createBreadcrumb({ onJump }: BreadcrumbHandlers): Breadcrumb {
  const el = create("nav", "breadcrumb");
  el.setAttribute("aria-label", "현재 폴더 경로");

  const render = (root: string): void => {
    const segments = breadcrumbSegments(root);
    el.replaceChildren();
    if (segments.length === 0) {
      el.title = "";
      el.removeAttribute("aria-label");
      el.setAttribute("aria-label", "현재 폴더 경로");
      return;
    }
    el.title = root;
    el.setAttribute("aria-label", `현재 폴더 경로: ${root}`);
    segments.forEach((seg, i) => {
      if (i > 0) {
        const sep = create("span", "breadcrumb-sep");
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "›";
        el.append(sep);
      }
      const btn = create("button", "breadcrumb-seg");
      btn.type = "button";
      btn.textContent = seg.label;
      btn.dataset.abs = seg.abs;
      if (i === segments.length - 1) btn.setAttribute("aria-current", "true");
      el.append(btn);
    });
    // Anchor the view to the RIGHT end: when the trail overflows, the current
    // folder (the segment that identifies "where am I") must stay visible and
    // the root side is what clips — the opposite of the default scroll-left
    // resting position. Trackpad scroll still reaches the clipped ancestors
    // (the scrollbar itself is hidden in CSS — see .breadcrumb).
    el.scrollLeft = el.scrollWidth;
  };

  // Single delegated listener (recent/outline/explorer single-path shape):
  // click any segment button → jump to its real absolute path.
  el.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".breadcrumb-seg") as HTMLElement | null;
    if (!btn?.dataset.abs) return;
    onJump(btn.dataset.abs);
  });

  return { el, render };
}
