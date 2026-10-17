// Remote-vault video bytes: the ONE place a remote document's `![[clip.mp4]]`
// target becomes a Blob. Reuses the bytes-only viewers' fetch choke point
// (readRemoteFileBytes -> remote_read_asset, ArrayBuffer, 20 MiB host cap whose
// 413 is translated to REMOTE_ASSET_TOO_LARGE_MESSAGE there). The host's
// Content-Type is never used — it reports videos as octet-stream — so the MIME
// comes from the extension (videoMimeFor).
import { readRemoteFileBytes } from "../chrome/viewer/file-bytes";
import type { RemoteViewerSource } from "../chrome/viewer/registry";
import { boundedCache } from "./bounded-cache";
import { videoMimeFor } from "./video-mime";

type RemoteVideoVault = Pick<RemoteViewerSource, "host" | "remoteVaultId">;

/** Holds Blobs (not object URLs): each widget DOM mints and revokes its own URL,
 *  so evicting an entry can never pull a URL out from under a playing video. */
const remoteVideoCache = boundedCache<string, Promise<Blob>>(3);
const remoteVideoCacheKey = (vault: RemoteVideoVault, path: string): string =>
  `${vault.host} ${vault.remoteVaultId} ${path}`;

/** Vault-relative path -> Blob typed by extension, cached by (host, vault, path).
 *  A rejection evicts its own entry so the next call retries. Command-shaped
 *  (async IO; rejects with the size message for a >20 MiB file). */
export function loadRemoteVideo(vault: RemoteVideoVault, path: string): Promise<Blob> {
  const key = remoteVideoCacheKey(vault, path);
  const hit = remoteVideoCache.get(key);
  if (hit) return hit;
  const pending = readRemoteFileBytes({ host: vault.host, remoteVaultId: vault.remoteVaultId, path }).then(
    (buf) => new Blob([buf], { type: videoMimeFor(path) ?? "" }),
  );
  remoteVideoCache.put(key, pending);
  pending.catch(() => {
    if (remoteVideoCache.get(key) === pending) remoteVideoCache.delete(key);
  });
  return pending;
}

/** Test-only. */
export function clearRemoteVideoCache(): void {
  remoteVideoCache.clear();
}
