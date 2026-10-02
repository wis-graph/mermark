// Remote-vault image loading: the ONE place a remote document's image target
// (`![[name]]` / `![](path)`) becomes bytes, and the ONE place a failure of
// that becomes observable. Split out of image.ts so the image VIEWER
// (chrome/viewer/image-viewer.ts) shares the exact same cache the inline
// widget fills — a widget-fetched image reopened in the viewer costs no
// network round trip. (design §3.3-4, §5.4, §7.)
//
// Imports `resolveImageSrc` from image.ts while image.ts imports this module:
// a cycle, but call-time only (no top-level evaluation reads the other side).
import { invoke } from "@tauri-apps/api/core";
import { fileHostFor } from "../document/file-host";
import { recursiveImageSearchSetting } from "../settings/app";
import { REMOTE_VAULT_WIRE_ROOT, type RemoteVault } from "../workspace/workspace-state";
import { boundedCache } from "./bounded-cache";
import { resolveImageSrc } from "./image";
import { searchPlanFor } from "./image-search-root";

/** Structural — RemoteVault and RemoteViewerSource both satisfy it. */
export interface RemoteImageVault {
  readonly host: string;
  readonly remoteVaultId: string;
}

type Scope = "vault" | "folder";
type FailureStage = "literal" | "resolve" | "not-found" | "read-resolved";

/** Caches `remote_read_image` results by (host, remote vault id, path) — the
 *  same "don't refetch on every reveal/unreveal cycle" concern boundedCache
 *  solves for mermaid/math renders, for a network round-trip. A rejection
 *  evicts its own entry (a later call retries). */
const remoteImageCache = boundedCache<string, Promise<string>>(64);
const remoteImageCacheKey = (vault: RemoteImageVault, path: string): string =>
  `${vault.host} ${vault.remoteVaultId} ${path}`;

/** data: URL for one vault-relative path, cached; a rejection is evicted
 *  (retry later) and propagated — the caller reports it. Command-shaped
 *  (async IO). */
export function readRemoteImage(
  vault: RemoteImageVault,
  path: string,
  call: typeof invoke = invoke,
): Promise<string> {
  const key = remoteImageCacheKey(vault, path);
  let pending = remoteImageCache.get(key);
  if (!pending) {
    pending = call<string>("remote_read_image", { host: vault.host, vault: vault.remoteVaultId, path });
    remoteImageCache.put(key, pending);
    pending.catch(() => remoteImageCache.delete(key));
  }
  return pending;
}

const reportedFailures = new Set<string>();

/** console.warn once per (host, vault, baseDir, rawSrc, stage) — the one
 *  place a remote image failure becomes observable (no packaged-app UI
 *  channel exists yet; same level as image.ts's vault-downgrade report).
 *  Command (void). */
export function reportRemoteImageFailure(
  vault: RemoteImageVault,
  rawSrc: string,
  baseDir: string,
  stage: FailureStage,
  cause?: unknown,
): void {
  const key = `${vault.host} ${vault.remoteVaultId} ${baseDir} ${rawSrc} ${stage}`;
  if (reportedFailures.has(key)) return;
  reportedFailures.add(key);
  const raw = cause === undefined ? "" : ` — ${cause instanceof Error ? cause.message : String(cause)}`;
  console.warn(
    `[mermark] remote image "${rawSrc}" (base "${baseDir}", vault ${vault.host}/${vault.remoteVaultId}) failed at stage ${stage}${raw}`,
  );
}

export type RemoteEmbedHit = { readonly dataUrl: string; readonly path: string };

const embedCache = boundedCache<string, Promise<RemoteEmbedHit | null>>(64);

/** Literal path first (parity with local: literal wins), then a name search per
 *  `searchPlanFor(scope, REMOTE_VAULT_WIRE_ROOT, baseDir)`. Resolves to the data
 *  URL + the vault-relative path it came from, or null (already reported).
 *  Only a FINAL failure is reported; "literal 404 then search hit" is the
 *  normal path. A null/failed result is evicted so a later attempt retries
 *  (the file may show up after an attach). Command-shaped (async IO). */
export function loadRemoteEmbed(
  vault: RemoteVault,
  rawSrc: string,
  baseDir: string,
  scope: Scope,
): Promise<RemoteEmbedHit | null> {
  const key = `${vault.host} ${vault.remoteVaultId} ${baseDir} ${rawSrc} ${scope}`;
  const cached = embedCache.get(key);
  if (cached) return cached;
  const pending = resolveRemoteEmbed(vault, rawSrc, baseDir, scope);
  embedCache.put(key, pending);
  void pending.then((hit) => { if (!hit) embedCache.delete(key); }, () => embedCache.delete(key));
  return pending;
}

async function resolveRemoteEmbed(
  vault: RemoteVault,
  rawSrc: string,
  baseDir: string,
  scope: Scope,
): Promise<RemoteEmbedHit | null> {
  const literalPath = resolveImageSrc(rawSrc, baseDir);
  let literalError: unknown;
  try {
    return { dataUrl: await readRemoteImage(vault, literalPath), path: literalPath };
  } catch (e) {
    literalError = e;
  }

  // `""` (REMOTE_VAULT_WIRE_ROOT) is a VALID vault root here — never guard
  // this plan with `if (!plan.baseDir)` (that is the local onerror's check;
  // copying it would silently disable every vault-scope remote search).
  const plan = searchPlanFor(scope, REMOTE_VAULT_WIRE_ROOT, baseDir);
  if (plan.gated && recursiveImageSearchSetting.get() !== "on") {
    reportRemoteImageFailure(vault, rawSrc, baseDir, "literal", literalError);
    return null;
  }

  let found: string | null;
  try {
    found = await fileHostFor(vault).resolveImage(plan.baseDir, rawSrc, plan.maxDepth);
  } catch (e) {
    reportRemoteImageFailure(vault, rawSrc, baseDir, "resolve", e);
    return null;
  }
  if (!found) {
    reportRemoteImageFailure(vault, rawSrc, baseDir, "not-found", literalError);
    return null;
  }
  try {
    return { dataUrl: await readRemoteImage(vault, found), path: found };
  } catch (e) {
    reportRemoteImageFailure(vault, rawSrc, baseDir, "read-resolved", e);
    return null;
  }
}

/** Test-only escape hatch. */
export function clearRemoteImageCache(): void {
  remoteImageCache.clear();
  embedCache.clear();
}

/** Test-only escape hatch. */
export function clearRemoteImageFailureReports(): void {
  reportedFailures.clear();
}
