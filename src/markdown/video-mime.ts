// Leaf module (no imports): video extension table + MIME lookup, shared by
// embed.ts and remote-video.ts so they don't depend on each other.

/** Video extension -> MIME: the one table both isVideoTarget and the remote
 *  Blob type derive from (the host's own Content-Type is octet-stream). */
export const VIDEO_MIME_BY_EXT: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  ogv: "video/ogg",
  mov: "video/quicktime",
};

/** An embed target without its `#…` media fragment, trimmed. Pure. */
export function stripFragment(target: string): string {
  return target.split("#")[0].trim();
}

/** MIME for a video target's extension (fragment stripped), or null. Pure. */
export function videoMimeFor(target: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(stripFragment(target));
  return (m && VIDEO_MIME_BY_EXT[m[1].toLowerCase()]) || null;
}
