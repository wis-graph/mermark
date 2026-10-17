// Remote-vault videos (relative targets in a remote document) can't use the local
// asset URL: they load on click via loadRemoteVideo (remote_read_asset -> Blob ->
// object URL), capped by the host's 20 MiB per-asset limit. Larger files show the
// "너무 큽니다" message; true streaming (host Range support) is a follow-up that
// would also require reinstalling the host.
import { WidgetType, type EditorView } from "@codemirror/view";
import { isHostFetchedEmbed, resolveImageSrc, resolveImageUrl } from "./image";
import { documentVault } from "../document/document-vault";
import { loadRemoteVideo } from "./remote-video";
import { stripFragment, videoMimeFor } from "./video-mime";

export { videoMimeFor };
import { remoteFetchErrorMessage } from "../chrome/viewer/file-bytes";
import { basename } from "../document/path";
import type { RemoteVault } from "../workspace/workspace-state";

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
  return videoMimeFor(target) !== null;
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
  if (isVideoTarget(target)) return new VideoWidget(resolveImageUrl(target, baseDir), alt, target, baseDir);
  return null;
}

/** The plain inline <video controls> (local files, and https passthrough). */
function buildPlainVideo(url: string, alt: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.className = "cm-video";
  video.controls = true;
  video.src = url;
  if (alt) video.title = alt;
  return video;
}

/** object URL minted per loaded remote-video DOM -> revoked in destroy(). */
const objectUrlOf = new WeakMap<HTMLElement, string>();
/** Facades whose widget was destroyed — a late load must not mint a URL for them. */
const destroyedBoxes = new WeakSet<HTMLElement>();

/** Remote-video facade: a load button + caption. Click -> loadRemoteVideo ->
 *  swap in a <video> on a Blob object URL (recorded for revoke). Command-shaped
 *  builder (returns the DOM it wires). */
function buildRemoteVideoFacade(vault: RemoteVault, remotePath: string, fragment: string, alt: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-video-remote";
  if (alt) box.title = alt;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-video-remote-load";
  button.textContent = "▶ 원격 동영상 불러오기";
  const caption = document.createElement("span");
  caption.className = "cm-video-remote-caption";
  caption.textContent = basename(remotePath);
  box.append(button, caption);
  button.addEventListener("click", () => {
    button.disabled = true;
    caption.textContent = "불러오는 중…";
    loadRemoteVideo(vault, remotePath).then(
      (blob) => {
        if (destroyedBoxes.has(box) || !box.isConnected) return; // widget gone (destroyed or its DOM torn down without destroy) before the bytes arrived: mint nothing
        const url = URL.createObjectURL(blob);
        objectUrlOf.set(box, url);
        const video = buildPlainVideo(url + fragment, alt);
        video.autoplay = true;
        box.replaceChildren(video);
      },
      (e) => {
        button.hidden = true;
        caption.textContent = remoteFetchErrorMessage(e);
        caption.classList.add("is-error");
      },
    );
  });
  return box;
}

/** Inline <video controls>. The caller resolves local paths to asset URLs
 *  (image.ts resolveImageUrl); remote https is passed through. In a remote vault a
 *  vault-relative target is host-fetched instead: click-to-load via
 *  loadRemoteVideo (Blob/object URL). The branch lives in toDOM(view) so
 *  embedWidgetFor stays pure. */
export class VideoWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly rawSrc = "",
    readonly baseDir = "",
  ) {
    super();
  }
  eq(o: VideoWidget) {
    return o.url === this.url && o.rawSrc === this.rawSrc && o.baseDir === this.baseDir;
  }
  toDOM(view?: EditorView) {
    const vault = view?.state.facet(documentVault);
    if (!isHostFetchedEmbed(vault, this.rawSrc)) return buildPlainVideo(this.url, this.alt);
    const fragmentAt = this.rawSrc.indexOf("#");
    const fragment = fragmentAt >= 0 ? this.rawSrc.slice(fragmentAt).trim() : "";
    const remotePath = resolveImageSrc(stripFragment(this.rawSrc), this.baseDir);
    return buildRemoteVideoFacade(vault, remotePath, fragment, this.alt);
  }
  destroy(dom: HTMLElement) {
    destroyedBoxes.add(dom);
    const url = objectUrlOf.get(dom);
    if (url !== undefined) {
      URL.revokeObjectURL(url);
      objectUrlOf.delete(dom);
    }
  }
  ignoreEvent() {
    return true; // control clicks must not move the caret
  }
}
