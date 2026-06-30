import { WidgetType } from "@codemirror/view";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { recursiveImageSearchSetting } from "../settings/app";

/** Resolve a markdown image target to an absolute filesystem path (or pass through URLs). */
export function resolveImageSrc(src: string, baseDir: string): string {
  if (/^https?:\/\//i.test(src) || src.startsWith("data:")) return src;
  if (src.startsWith("/")) return src;
  return `${baseDir.replace(/\/$/, "")}/${src}`;
}

/** Same, but local paths become webview-loadable asset URLs. */
export function resolveImageUrl(src: string, baseDir: string): string {
  const abs = resolveImageSrc(src, baseDir);
  return /^https?:|^data:/i.test(abs) ? abs : convertFileSrc(abs);
}

/** A literal target is a remote/data URL — it never gets the recursive-search
 *  fallback (the scan is a filesystem walk under baseDir; only local files can be
 *  rediscovered). Named so the onerror handler asks intent, not a regex inline. */
function isRemoteSrc(rawSrc: string): boolean {
  return /^https?:\/\//i.test(rawSrc) || rawSrc.startsWith("data:");
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
  toDOM() {
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
          if (found) img.src = convertFileSrc(found);
        })
        .catch(() => {
          /* best-effort fallback: a backend error leaves the broken image as-is */
        });
    };
    return img;
  }
  ignoreEvent() {
    return true;
  }
}
