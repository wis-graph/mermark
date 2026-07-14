// The image viewer: a body-level lightbox overlay for explorer image clicks,
// structurally cloned from the conflict modal (../conflict/conflict-modal.ts) —
// backdrop / dialog / capture-phase Esc / editor-host `inert` / last-focus
// restore. Lives entirely outside the editor host (never inside .cm-content),
// so it makes zero decorations: the render-smoke invariant ("block decorations
// come from a StateField") has no intersection here, and the ⌘± zoom measure
// guard is untouched. Built lazily (only on an explorer image click), torn
// down completely on close() — no persistent DOM/listeners between opens.
import { attachPanZoom } from "../../markdown/mermaid-widget";
import { resolveImageUrl } from "../../markdown/image";
import { basename, dirOf } from "../../document/path";

export interface ImageViewerHandle {
  /** Tear down: remove the DOM + listeners, stop pan/zoom, restore the editor
   *  + focus. Idempotent — safe to call more than once (Esc + backdrop click
   *  racing, or a caller closing defensively). */
  close(): void;
}

/** The caption text for a loaded image: filename + its natural pixel size, the
 *  single "what does the caption say" rule so onload and any future caller
 *  agree on the format. Pure query. */
function loadedCaption(name: string, img: HTMLImageElement): string {
  return `${name} — ${img.naturalWidth}×${img.naturalHeight}`;
}

/** Open the lightbox for `absPath`. Reuses `resolveImageUrl` (the same local
 *  path → asset URL rule markdown images use) so there is exactly one owner
 *  of that conversion. Returns a handle whose close() restores the page. */
export function openImageViewer(absPath: string): ImageViewerHandle {
  const lastFocused = document.activeElement;
  const name = basename(absPath);

  const backdrop = document.createElement("div");
  backdrop.className = "viewer-backdrop";

  const modal = document.createElement("div");
  modal.className = "image-viewer";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", name);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "image-viewer-close";
  closeBtn.setAttribute("aria-label", "닫기");
  closeBtn.textContent = "✕";

  // The checkerboard stage doubles as the pan/zoom host (attachPanZoom reuse —
  // mermaid-widget's handler only ever touches host/element geometry + CSS
  // transform, both of which an <img> supports identically to an <svg>).
  const stage = document.createElement("div");
  stage.className = "image-viewer-stage";

  const img = document.createElement("img");
  img.className = "image-viewer-img";
  img.alt = name;

  const caption = document.createElement("div");
  caption.className = "image-viewer-caption";
  caption.textContent = name;

  img.onload = () => {
    caption.textContent = loadedCaption(name, img);
  };
  img.onerror = () => {
    // The viewer stays open on a load failure — closing is the user's call,
    // not ours (same "best-effort, never auto-dismiss" stance as ImageWidget's
    // recursive-search fallback).
    caption.textContent = "이미지를 불러올 수 없습니다";
  };
  img.src = resolveImageUrl(absPath, dirOf(absPath));

  stage.append(img);
  modal.append(closeBtn, stage, caption);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const editorHost = () => document.querySelector<HTMLElement>(".editor-host");
  editorHost()?.setAttribute("inert", "");

  const pz = attachPanZoom(stage, img);

  const handle: ImageViewerHandle = {
    close() {
      document.removeEventListener("keydown", onKeydown, true);
      pz.destroy();
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
