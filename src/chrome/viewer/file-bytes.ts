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
import { convertFileSrc } from "@tauri-apps/api/core";

/** Read `absPath`'s raw bytes via the asset protocol. Throws on a non-ok
 *  response (caller decides how to surface a load failure — this module owns
 *  only the fetch rule, not error UI). Command-shaped (async, throws) rather
 *  than a pure query, since it performs real IO. */
export async function readLocalFileBytes(absPath: string): Promise<ArrayBuffer> {
  const res = await fetch(convertFileSrc(absPath));
  if (!res.ok) throw new Error(`readLocalFileBytes: ${res.status} ${res.statusText} for ${absPath}`);
  return res.arrayBuffer();
}
