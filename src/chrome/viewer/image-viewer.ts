// The image viewer: an in-content pane for explorer image clicks (full-pane
// rewrite, _workspace/01_architect_design.md — supersedes R11's body-level
// lightbox). Built on the shared `openViewerShell` (in-content pane /
// capture-phase Esc / `.editor-host` hidden / last-focus restore / the zoom
// state machine) instead of duplicating that chrome. It makes zero
// decorations: the render-smoke invariant ("block decorations come from a
// StateField") has no intersection here, and the ⌘± zoom measure guard is
// untouched. Built lazily (only on an explorer image click), torn down
// completely on close() — no persistent DOM/listeners between opens.
import { attachPanZoom } from "../../markdown/mermaid-widget";
import { resolveImageUrl } from "../../markdown/image";
import { basename, dirOf } from "../../document/path";
import { openViewerShell } from "./shell";
import type { ViewerHandle } from "./registry";

export type ImageViewerHandle = ViewerHandle;

/** The caption text for a loaded image: filename + its natural pixel size, the
 *  single "what does the caption say" rule so onload and any future caller
 *  agree on the format. Pure query. */
function loadedCaption(name: string, img: HTMLImageElement): string {
  return `${name} — ${img.naturalWidth}×${img.naturalHeight}`;
}

/** Scale the image's rendered width to `factor` × its natural width (design
 *  §B's per-viewer BEHAVIOR table: "레이아웃 폭 스케일"). At `factor === 1`
 *  (fit, the default), the inline overrides are REMOVED entirely so the CSS
 *  fit rule (`.image-viewer-img`'s `max-width/max-height: 100%`, styles.css)
 *  takes back over — never re-declared here, so there is exactly one "what
 *  does fit mean" rule. `attachPanZoom`'s own transform (pan) is a DIFFERENT
 *  CSS property (`transform`, not `width`) so the two coexist without a
 *  writer conflict: pan moves/scales the element visually, this changes its
 *  LAYOUT box. Skips the ≠1 branch before the image has ever loaded
 *  (`naturalWidth` is still 0) — a zoom click can only reach a live width
 *  once there is one to multiply. Command (void). */
function applyImageZoom(img: HTMLImageElement, factor: number): void {
  if (factor === 1) {
    img.style.removeProperty("width");
    img.style.removeProperty("max-width");
    img.style.removeProperty("max-height");
    return;
  }
  if (!img.naturalWidth) return;
  img.style.maxWidth = "none";
  img.style.maxHeight = "none";
  img.style.width = `${img.naturalWidth * factor}px`;
}

/** Open the lightbox for `absPath`. Reuses `resolveImageUrl` (the same local
 *  path → asset URL rule markdown images use) so there is exactly one owner
 *  of that conversion. Returns a handle whose close() restores the page. */
export function openImageViewer(absPath: string): ImageViewerHandle {
  const name = basename(absPath);

  // The checkerboard stage doubles as the pan/zoom host (attachPanZoom reuse —
  // mermaid-widget's handler only ever touches host/element geometry + CSS
  // transform, both of which an <img> supports identically to an <svg>).
  const stage = document.createElement("div");
  stage.className = "image-viewer-stage";

  const img = document.createElement("img");
  img.className = "image-viewer-img";
  img.alt = name;
  stage.append(img);

  const shell = openViewerShell({ absPath, paneClass: "image-viewer", content: stage });

  img.onload = () => {
    shell.caption.textContent = loadedCaption(name, img);
  };
  img.onerror = () => {
    // The viewer stays open on a load failure — closing is the user's call,
    // not ours (same "best-effort, never auto-dismiss" stance as ImageWidget's
    // recursive-search fallback).
    shell.caption.textContent = "이미지를 불러올 수 없습니다";
  };
  img.src = resolveImageUrl(absPath, dirOf(absPath));

  const pz = attachPanZoom(stage, img);
  shell.onTeardown(() => pz.destroy());

  const unsubscribeZoom = shell.zoom.bind((factor) => applyImageZoom(img, factor));
  shell.onTeardown(unsubscribeZoom);

  // onClose forwards the shell teardown so the OPENER learns about closes
  // it did not initiate (Esc / header ✕) — see ViewerHandle.onClose.
  return { close: () => shell.close(), onClose: (cb) => shell.onTeardown(cb) };
}
