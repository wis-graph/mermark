import { WidgetType } from "@codemirror/view";
import { resolveImageUrl } from "./image";

/** Extract the 11-char YouTube video id from a watch/youtu.be/embed/shorts URL,
 *  or null when the url isn't a recognizable YouTube link (→ caller falls back to
 *  image/wikilink rendering). Pure query. Extra params (`&t=…`) are ignored.
 *  Scope is http/https only (the 00 request's minimum); other hosts are out. */
export function youtubeId(url: string): string | null {
  const u = url.trim();
  const id = "([A-Za-z0-9_-]{11})";
  const patterns = [
    new RegExp(`^https?://(?:www\\.|m\\.)?youtube\\.com/watch\\?(?:[^#]*&)?v=${id}`),
    new RegExp(`^https?://youtu\\.be/${id}`),
    new RegExp(`^https?://(?:www\\.|m\\.)?youtube\\.com/embed/${id}`),
    new RegExp(`^https?://(?:www\\.|m\\.)?youtube\\.com/shorts/${id}`),
  ];
  for (const re of patterns) {
    const m = u.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Whether an embed target is a video file we can inline as <video>. Pure query.
 *  Mirrors isImageTarget: strips a `#…` suffix, matches known video extensions. */
export function isVideoTarget(target: string): boolean {
  return /\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(target.split("#")[0].trim());
}

/** Swap a facade container's contents for an autoplaying youtube-nocookie iframe.
 *  Named command (void, side-effecting). Idempotent: a second call after the
 *  iframe exists is a no-op, so repeated clicks don't restart playback. */
export function playInline(container: HTMLElement, id: string): void {
  if (container.querySelector("iframe")) return; // already playing
  container.replaceChildren();
  const iframe = document.createElement("iframe");
  iframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
  iframe.setAttribute("allow", "autoplay; encrypted-media");
  iframe.setAttribute("allowfullscreen", "");
  iframe.className = "cm-youtube-iframe";
  container.appendChild(iframe);
}

/** YouTube facade: a thumbnail + play overlay; clicking swaps in the iframe in
 *  place (light/privacy-friendly until the user opts to play). The click listener
 *  lives on the container DOM, so it's collected with the DOM when CM replaces the
 *  widget — no global listeners, no destroy() needed. */
export class YoutubeFacadeWidget extends WidgetType {
  constructor(readonly id: string, readonly alt: string) {
    super();
  }
  eq(o: YoutubeFacadeWidget) {
    return o.id === this.id; // selection churn must not rebuild (alt is cosmetic)
  }
  toDOM() {
    const container = document.createElement("div");
    container.className = "cm-youtube-facade";
    container.title = this.alt;
    const img = document.createElement("img");
    img.className = "cm-youtube-thumb";
    img.src = `https://img.youtube.com/vi/${this.id}/hqdefault.jpg`;
    img.alt = this.alt;
    const play = document.createElement("div");
    play.className = "cm-youtube-play";
    container.append(img, play);
    container.addEventListener("click", () => playInline(container, this.id));
    return container;
  }
  ignoreEvent() {
    return true; // the play click is the widget's own; never a caret/block entry
  }
}

/** The embed widget for a target, or null when it's neither a YouTube link nor a
 *  video file (caller then falls back to image/wikilink rendering). The single
 *  source of the youtube→video priority, shared by both the `![](…)` and `![[…]]`
 *  paths so they resolve embeds identically. Pure query. */
export function embedWidgetFor(target: string, alt: string, baseDir: string): WidgetType | null {
  const yt = youtubeId(target);
  if (yt) return new YoutubeFacadeWidget(yt, alt);
  if (isVideoTarget(target)) return new VideoWidget(resolveImageUrl(target, baseDir), alt);
  return null;
}

/** Inline <video controls>. The caller resolves local paths to asset URLs
 *  (image.ts resolveImageUrl); remote https is passed through. */
export class VideoWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) {
    super();
  }
  eq(o: VideoWidget) {
    return o.url === this.url;
  }
  toDOM() {
    const video = document.createElement("video");
    video.className = "cm-video";
    video.controls = true;
    video.src = this.url;
    if (this.alt) video.title = this.alt;
    return video;
  }
  ignoreEvent() {
    return true; // control clicks must not move the caret
  }
}
