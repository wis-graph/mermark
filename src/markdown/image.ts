import { EditorView, WidgetType } from "@codemirror/view";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { recursiveImageSearchSetting } from "../settings/app";
import { attachAltClickEdit } from "./wikilink";
import { requestImageOpen } from "./image-open";

/** A literal target is a remote/data URL — it never gets the recursive-search
 *  fallback (the scan is a filesystem walk under baseDir; only local files can be
 *  rediscovered). Named so every caller (resolveImageSrc/resolveImageUrl below,
 *  the onerror handler, the click handler, and the image viewer) asks the SAME
 *  question instead of each re-testing its own regex — `resolveImageUrl` used
 *  to carry a variant (`/^https?:|^data:/i`, no `//` required) that had already
 *  drifted from this one; unifying onto a single test removes that drift
 *  without changing which URLs count as remote (both variants agree on every
 *  well-formed `http(s)://…`/`data:…` input; the variant only differed on
 *  malformed ones like a bare `https:` with no host, which isRemoteSrc also
 *  still matches). Pure query. */
export function isRemoteSrc(rawSrc: string): boolean {
  return /^https?:\/\//i.test(rawSrc) || rawSrc.startsWith("data:");
}

/** Resolve a markdown image target to an absolute filesystem path (or pass through URLs). */
export function resolveImageSrc(src: string, baseDir: string): string {
  if (isRemoteSrc(src)) return src;
  if (src.startsWith("/")) return src;
  return `${baseDir.replace(/\/$/, "")}/${src}`;
}

/** Same, but local paths become webview-loadable asset URLs. */
export function resolveImageUrl(src: string, baseDir: string): string {
  const abs = resolveImageSrc(src, baseDir);
  return isRemoteSrc(abs) ? abs : convertFileSrc(abs);
}

/** How far (in CSS pixels) the pointer may move between mousedown and click
 *  on the image and still count as a click, not a drag release. A drag that
 *  starts and ends ON the image never fires a native `click` in most cases,
 *  but a tiny in-place jitter still does — this guard's actual job is the
 *  in-place-drag case (dragging a selection that starts and ends on the
 *  image itself). Pure query. */
const CLICK_DRAG_SLOP_PX = 4;

/** Whether the pointer moved far enough between mousedown and click to call
 *  this a drag release rather than a click — the domain rule "the end of a
 *  drag is not a click" named once instead of as an inline distance check.
 *  Pure query. */
function dragExceededClickSlop(downX: number, downY: number, e: MouseEvent): boolean {
  return Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_DRAG_SLOP_PX;
}

/** What clicking this widget should hand to the image viewer — pure query.
 *  `resolvedPath` (set once the recursive-search fallback in `onerror` found
 *  the real file) wins when present, so the viewer opens the SAME file the
 *  widget ended up showing, not the literal target that failed to load.
 *  Otherwise a remote/data `rawSrc` passes through untouched (never resolved
 *  against a `baseDir` it doesn't belong to), and a local path resolves to an
 *  absolute filesystem path the viewer can open. An empty `rawSrc` (the
 *  legacy no-arg constructor default) has nothing to open. */
export function viewerSourceFor(
  rawSrc: string,
  baseDir: string,
  resolvedPath: string | null,
): string | null {
  if (resolvedPath) return resolvedPath;
  if (!rawSrc) return null;
  if (isRemoteSrc(rawSrc)) return rawSrc;
  return resolveImageSrc(rawSrc, baseDir);
}

export class ImageWidget extends WidgetType {
  /** `url` is the literal-resolved asset URL (the cheap, no-cost path that
   *  preserves current behavior). `rawSrc`/`baseDir` are kept so a load failure
   *  can ask the backend to rediscover the file by basename under baseDir. */
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly rawSrc = "",
    readonly baseDir = "",
  ) {
    super();
  }
  eq(o: ImageWidget) {
    // The fallback result is a pure function of (url, rawSrc, baseDir), so the
    // identity must include all three — otherwise selection churn that rebuilds
    // with the same url but a stale rawSrc/baseDir would reuse the wrong DOM (or
    // re-trigger a resolve). Same widget ⇒ same rendered+resolved image.
    return o.url === this.url && o.rawSrc === this.rawSrc && o.baseDir === this.baseDir;
  }
  toDOM(view: EditorView) {
    const img = document.createElement("img");
    img.className = "cm-image";
    img.alt = this.alt;
    img.src = this.url;

    // Recursive-search fallback: when the literal src fails to load AND the
    // setting is on AND it's a local path, ask the backend to find the file by
    // basename under baseDir, then swap the src in. WikilinkWidget's
    // pending→invoke→DOM-swap pattern, adapted for <img onerror>.
    // `triedFallback` is a domain rule, not an optimization: onerror fires again
    // when the resolved src ALSO fails, so without this guard the fallback loops.
    let triedFallback = false;
    // Recorded when the fallback above actually finds the file — so a click
    // opens the viewer on the SAME file the widget ends up displaying, not
    // the literal target that failed (viewerSourceFor's first priority).
    let resolvedPath: string | null = null;
    img.onerror = () => {
      if (triedFallback) return;
      triedFallback = true;
      if (isRemoteSrc(this.rawSrc)) return; // remote/data never rediscovered
      if (recursiveImageSearchSetting.get() !== "on") return; // user opted out
      if (!this.rawSrc || !this.baseDir) return; // nothing to resolve against
      invoke<string | null>("resolve_image", {
        baseDir: this.baseDir,
        name: this.rawSrc,
        maxDepth: 3,
      })
        .then((found) => {
          if (found) {
            resolvedPath = found;
            img.src = convertFileSrc(found);
          }
        })
        .catch(() => {
          /* best-effort fallback: a backend error leaves the broken image as-is */
        });
    };

    // Click → open the image viewer (one click, no modifier — user-confirmed
    // decision, _workspace/01_architect_design_imgclick.md). A broken image
    // opens the viewer too (no branch): the viewer's own onerror stance
    // ("stay open with a failure caption") already covers it.
    let downX = 0;
    let downY = 0;
    img.addEventListener("mousedown", (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });
    img.addEventListener("click", (e) => {
      if (e.altKey) return; // Alt+click = edit source (attachAltClickEdit below)
      if (dragExceededClickSlop(downX, downY, e)) return; // drag release, not a click
      e.preventDefault();
      const source = viewerSourceFor(this.rawSrc, this.baseDir, resolvedPath);
      if (source) requestImageOpen(source);
    });
    attachAltClickEdit(img, view);

    return img;
  }
  ignoreEvent() {
    return true;
  }
}
