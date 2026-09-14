// The single owner of "read a local file's raw bytes" (R11, _workspace/01_r11.md
// §1). NO new Tauri command: `convertFileSrc` + fetch already works, backed by
// three independent facts (verified against this repo's HEAD, not assumed):
//   1. CSP `connect-src` allows the asset scheme — tauri.conf.json:16
//      (`asset: http://asset.localhost https://asset.localhost`).
//   2. `assetProtocol.scope.allow` is `["**"]` — tauri.conf.json:18 (any
//      absolute path is servable).
//   3. The SAME handler already serves bytes in production: markdown images
//      go through `resolveImageUrl` (../../markdown/image.ts) → convertFileSrc
//      → this exact protocol (../../chrome/viewer/image-viewer.ts's `img.src`).
// In `--mode browser` (no real Tauri), vite.config.ts's alias swaps
// convertFileSrc for the mock (identity passthrough) and Vite's publicDir
// (mock-assets/) serves the mock fixture at that literal path — so this
// function needs no browser-mode branching of its own.
//
// CONFIRMED ON A REAL DEVICE (2026-07-14, user, `npm run tauri dev`): this
// fetch resolves real bytes in the actual WKWebView, not just the mocked
// dev:browser harness — a real .xlsx opened and rendered its real cell
// values. This matters because Tauri's OWN docs never document this path:
// every official asset-protocol example is `<img src>`/`<video src>` (a
// browser-native element resolving the URL itself), and every CSP example
// only shows `img-src`. Nothing in Tauri's docs confirms `fetch()` against
// an asset:// URL specifically works — the 3-fact argument above is this
// codebase's OWN reasoning from CSP + scope + prior art, not something
// Tauri's docs promise. If a future Tauri upgrade ever breaks this, the
// break is isolated to this one function (every caller only ever sees
// `readLocalFileBytes(absPath): Promise<ArrayBuffer>`).
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { RemoteViewerSource } from "./registry";

/** Read `absPath`'s raw bytes via the asset protocol. Throws on a non-ok
 *  response (caller decides how to surface a load failure — this module owns
 *  only the fetch rule, not error UI). Command-shaped (async, throws) rather
 *  than a pure query, since it performs real IO. */
export async function readLocalFileBytes(absPath: string): Promise<ArrayBuffer> {
  const res = await fetch(convertFileSrc(absPath));
  if (!res.ok) throw new Error(`readLocalFileBytes: ${res.status} ${res.statusText} for ${absPath}`);
  return res.arrayBuffer();
}

// T6 (0.18.0, design §4.5/§4.6): the remote counterpart of
// `readLocalFileBytes` — same "raw bytes, nothing more" contract, backed by
// a DIFFERENT transport (`remote_read_asset`, not the asset protocol; there
// is no local filesystem to address for a remote vault). The four
// bytes-only viewers (pdf/docx/excel/html-OFF) each call ONE of
// `readLocalFileBytes`/`readRemoteFileBytes` depending on which `Viewer`
// method (`open`/`openRemote`) they were entered through — this is the
// initial-fetch half of the L1/L2/L3 leak-class fix (registry.ts's
// `RemoteViewerSource` doc comment): a remote source can never reach
// `readLocalFileBytes`'s `convertFileSrc` because its TYPE (`RemoteViewerSource`,
// not `string`) doesn't fit that parameter.
//
// data: URL round-trip deliberately NOT used here (unlike `remote_read_image`):
// base64 inflates a byte stream 33% and holds both the encoded AND decoded
// form in memory at once — fine for an image (hundreds of KB), not for a
// 15 MiB xlsx/PDF at the 20 MiB host cap (design §4.5's "~53 MiB in one IPC
// string" arithmetic). `remote_read_asset` instead returns `tauri::ipc::Response`
// (raw bytes), which Tauri delivers to JS as an ArrayBuffer.

/** Does `e` report the host's 20 MiB per-asset transfer cap (`remote_read_asset`'s
 *  `REMOTE_ASSET_TOO_LARGE:` prefix, design §4.5) — distinct from the 4-state
 *  `RemoteStatus` connection failures (`status_for`'s `Unreachable` etc.).
 *  Without this split, a file that is simply too big to fetch reads to the
 *  user as "연결할 수 없습니다" (a networking lie): the fix is a working
 *  connection to a host that is refusing THIS ONE request on size grounds,
 *  not a broken connection. Pure query. */
export function isRemoteAssetTooLarge(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("REMOTE_ASSET_TOO_LARGE:");
}

/** The user-facing text for `isRemoteAssetTooLarge` — the one place that
 *  wording lives, so a caller never hand-writes its own paraphrase. */
export const REMOTE_ASSET_TOO_LARGE_MESSAGE = "원격 파일이 너무 큽니다(20MB 초과). 호스트 기기에서 직접 열어 주세요.";

/** Normalize whatever shape `invoke("remote_read_asset", …)` hands back into
 *  an `ArrayBuffer` — Tauri's documented contract for a Rust
 *  `tauri::ipc::Response` is an `ArrayBuffer` on the JS side, but this
 *  function tolerates a `Uint8Array`/plain byte array too so a backend
 *  fallback (design §8-B: a `Vec<u8>` JSON array, if `ipc::Response` turns
 *  out not to behave as documented in this Tauri version) doesn't require a
 *  matching frontend change. Pure query. */
function toArrayBuffer(raw: unknown): ArrayBuffer {
  // `Object.prototype.toString.call` (not `instanceof ArrayBuffer`/
  // `ArrayBuffer.isView`) — a test/embedder environment can hand back an
  // ArrayBuffer/typed array minted in a DIFFERENT realm than this module's
  // own global (jsdom's `window.ArrayBuffer` vs. Node's, in vitest);
  // `instanceof` and `ArrayBuffer.isView` both fail across that boundary
  // even though the value is a perfectly real ArrayBuffer/view (confirmed:
  // a jsdom-realm check on a Node-realm TextEncoder buffer returned
  // `instanceof` false with `constructor.name` still "ArrayBuffer"). The
  // tag string survives the realm difference — it reads the internal
  // `[[Class]]` slot, not the constructor identity.
  const tag = Object.prototype.toString.call(raw);
  if (tag === "[object ArrayBuffer]") return raw as ArrayBuffer;
  if (tag.startsWith("[object ") && ArrayBuffer.isView(raw as ArrayBufferView)) {
    const view = raw as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(raw)) return new Uint8Array(raw as number[]).buffer;
  throw new Error("readRemoteFileBytes: unexpected response shape from remote_read_asset");
}

/** Read a remote vault file's raw bytes via `remote_read_asset` — the
 *  bytes-only viewers' (pdf/docx/excel/html-OFF) single remote fetch
 *  choke point, mirroring `readLocalFileBytes`'s role for the local
 *  path. `source.path` is vault-relative; the host's own `safe_path`
 *  (remote_host.rs) is the authority on path containment — this function
 *  does no path validation of its own, same division of responsibility
 *  `remote_read_image`/`remote_list_dir` already rely on. Command-shaped
 *  (async, throws). */
export async function readRemoteFileBytes(source: RemoteViewerSource): Promise<ArrayBuffer> {
  let raw: unknown;
  try {
    raw = await invoke("remote_read_asset", { host: source.host, vault: source.remoteVaultId, path: source.path });
  } catch (e) {
    // Translate the size-cap failure to its own Korean wording HERE, at the
    // single fetch choke point — every caller (all four bytes-only viewers)
    // gets the correct "file too big" message for free instead of each
    // having to remember to call `isRemoteAssetTooLarge` itself. Any other
    // rejection (a 4-state connection failure, a host-side path refusal)
    // passes through unchanged; this function does not own that wording.
    if (isRemoteAssetTooLarge(e)) throw new Error(REMOTE_ASSET_TOO_LARGE_MESSAGE);
    throw e;
  }
  return toArrayBuffer(raw);
}
