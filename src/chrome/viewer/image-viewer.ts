// The image viewer: a body-level lightbox overlay for explorer image clicks.
// Since R11 (_workspace/01_r11.md §5) this is built on the shared
// `openViewerShell` (backdrop / dialog / capture-phase Esc / editor-host
// `inert` / last-focus restore) instead of duplicating that chrome — DOM
// class structure and behavior are unchanged (golden G1 pins this). It makes
// zero decorations: the render-smoke invariant ("block decorations come from
// a StateField") has no intersection here, and the ⌘± zoom measure guard is
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

  const shell = openViewerShell({ absPath, modalClass: "image-viewer", content: stage });

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

  return { close: () => shell.close() };
}
