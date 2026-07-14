// The overlay SHELL every body-level viewer (image lightbox, Excel, and the
// 2/3-stage HTML/HWP viewers) shares — extracted from image-viewer.ts (R11,
// _workspace/01_r11.md §5), which is itself a structural clone of the
// conflict modal (../conflict/conflict-modal.ts). This is the ONLY refactor
// in R11's scope: without it, every new viewer would re-implement the same
// a11y-critical backdrop/Esc/inert/focus-restore logic (and inevitably drift).
//
// Lives entirely outside the editor host (never inside .cm-content), so it
// makes zero decorations — the render-smoke invariant ("block decorations
// come from a StateField") has no intersection here, and the ⌘± zoom measure
// guard is untouched.
import { basename } from "../../document/path";

export interface ViewerShell {
  /** Slot for the caller's content, sitting between the close button and the
   *  caption — same DOM order as the pre-shell image-viewer (closeBtn,
   *  content, caption). Callers append their own markup here. */
  caption: HTMLElement;
  /** Register a callback to run exactly once, inside close() — for a
   *  caller's own teardown (pan/zoom destroy, sheet worker cleanup, ...).
   *  Multiple registrations all run, in registration order. */
  onTeardown(cb: () => void): void;
  /** Idempotent close: removes the DOM, restores `.editor-host` (drops
   *  `inert`), and restores focus to whatever had it before open(). */
  close(): void;
}

/** Open the shared overlay shell: backdrop, dialog chrome (role=dialog,
 *  aria-modal, aria-label = basename), a close button, and the caller's
 *  `content` in between. Every invariant here is copied verbatim from
 *  image-viewer.ts (pre-extraction) so the shell-based image viewer is
 *  byte-for-byte behavior-identical — this function IS that checklist:
 *  `.viewer-backdrop` class · role=dialog/aria-modal · capture-phase Esc ·
 *  `.editor-host` inert on open / removed on close · lastFocused restore ·
 *  closeBtn gets initial focus · backdrop-self-click-only closes · close is
 *  idempotent.
 *
 *  VISUAL CHROME (background/border/shadow/padding/flex layout for the
 *  panel, position for the close button, typography for the caption) comes
 *  from the SHARED `.viewer-panel`/`.viewer-panel-close`/`.viewer-panel-caption`
 *  classes (styles.css) — added here alongside each viewer's own
 *  `modalClass`-derived class, never left for a viewer to reinvent. This is
 *  the fix for a real regression: the Excel viewer shipped with a modal that
 *  had no background/padding/layout at all, because that chrome used to be
 *  hardcoded to `.image-viewer` only and every other viewer's modal class
 *  matched nothing (audit finding, _workspace/04_audit_report.md). A viewer
 *  should only ever need to style its OWN content via `modalClass`-scoped
 *  selectors (e.g. `.excel-viewer-table`), never the panel shell.
 *
 *  SIZE CONTAINMENT + SCROLL is ALSO shell-owned (second regression the same
 *  audit found on a real device: a 10,000+-row sheet rendered past the
 *  panel's fixed height, uncontained, because `opts.content` was appended
 *  DIRECTLY as a flex item of `modal` — a plain block div with no flex
 *  properties of its own, so a `flex:1`/`overflow:auto` rule *inside* a
 *  viewer's content never had a flex ancestor to act against, and `modal`'s
 *  default `overflow: visible` let it spill silently). `opts.content` is
 *  now wrapped in `.viewer-panel-body` — a flex-column, `min-height: 0`
 *  container that gives EVERY viewer's content a bounded box with a real
 *  flex context to grow/scroll inside, without that viewer needing to know
 *  why. A viewer that wants its own content to scroll just needs ONE
 *  `flex: 1; min-height: 0; overflow: auto` rule on its own inner element —
 *  the containing box is already guaranteed. */
export function openViewerShell(opts: {
  absPath: string;
  /** "image-viewer" | "excel-viewer" | ... — an existing or new CSS
   *  selector; DOM class structure stays exactly what image-viewer.ts had.
   *  Paired with the shared `.viewer-panel*` classes below, so this only
   *  needs to carry a viewer's CONTENT-specific styling, not its chrome. */
  modalClass: string;
  content: HTMLElement;
}): ViewerShell {
  const lastFocused = document.activeElement;
  const name = basename(opts.absPath);
  const teardowns: (() => void)[] = [];

  const backdrop = document.createElement("div");
  backdrop.className = "viewer-backdrop";

  const modal = document.createElement("div");
  modal.className = `${opts.modalClass} viewer-panel`;
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", name);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = `${opts.modalClass}-close viewer-panel-close`;
  closeBtn.setAttribute("aria-label", "닫기");
  closeBtn.textContent = "✕";

  const caption = document.createElement("div");
  caption.className = `${opts.modalClass}-caption viewer-panel-caption`;
  caption.textContent = name;

  // Shell-owned scroll boundary (see comment above) — every viewer's content
  // lands inside this, never directly as a flex item of `modal`.
  const body = document.createElement("div");
  body.className = "viewer-panel-body";
  body.appendChild(opts.content);

  modal.append(closeBtn, body, caption);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const editorHost = () => document.querySelector<HTMLElement>(".editor-host");
  editorHost()?.setAttribute("inert", "");

  let closed = false;
  const handle: ViewerShell = {
    caption,
    onTeardown(cb) {
      teardowns.push(cb);
    },
    close() {
      if (closed) return; // idempotent — Esc + backdrop click can race
      closed = true;
      document.removeEventListener("keydown", onKeydown, true);
      for (const cb of teardowns) cb();
      backdrop.remove();
      editorHost()?.removeAttribute("inert");
      (lastFocused as HTMLElement | null)?.focus?.();
    },
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handle.close();
    }
  };

  closeBtn.addEventListener("click", () => handle.close());
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) handle.close(); // backdrop click closes; inside doesn't
  });
  document.addEventListener("keydown", onKeydown, true);

  closeBtn.focus(); // opened with focus on the close action (accessibility)
  return handle;
}
