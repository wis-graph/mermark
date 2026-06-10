import { WidgetType } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";

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

export class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) {
    super();
  }
  eq(o: ImageWidget) {
    return o.url === this.url;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-image";
    img.alt = this.alt;
    img.src = this.url;
    return img;
  }
  ignoreEvent() {
    return true;
  }
}
