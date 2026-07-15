import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, extname } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// PDF viewer (src/extensions/pdf-viewer): pdfjs-dist's wasm/cmaps/standard_fonts/
// iccs/worker/text-layer-css are DIRECTORY assets vite's normal `import`/asset
// pipeline never touches (they're read by pdf.js at runtime via a URL string
// getDocument() is handed, not statically imported by any module). No new dev
// dependency — this plugin serves them from node_modules in dev and copies them
// into dist/pdfjs at build time with plain node:fs, mirroring the shape every
// other static-asset need in this repo (mock-assets/publicDir) already uses.
// Every path pdf-viewer/index.ts passes to getDocument (cMapUrl/standardFontDataUrl/
// iccUrl/wasmUrl) and the worker Worker(...) URL are same-origin "/pdfjs/..."
// strings — CSP `script-src 'self'` / `connect-src 'self'` never sees a
// cross-origin request for any of this.
const PDFJS_ROOT = fileURLToPath(new URL("./node_modules/pdfjs-dist", import.meta.url));
const PDFJS_ASSET_DIRS = ["build", "wasm", "cmaps", "standard_fonts", "iccs", "web"];

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".mjs":
    case ".js":
      return "text/javascript";
    case ".wasm":
      return "application/wasm";
    case ".css":
      return "text/css";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

function copyDirRecursive(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    const dest = join(destDir, name);
    if (statSync(src).isDirectory()) copyDirRecursive(src, dest);
    else copyFileSync(src, dest);
  }
}

function pdfjsAssetsPlugin(): Plugin {
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith("/pdfjs/")) return next();
        const rel = req.url.slice("/pdfjs/".length).split("?")[0].split("#")[0];
        const abs = join(PDFJS_ROOT, rel);
        // Path-traversal guard — abs must stay inside PDFJS_ROOT.
        if (!abs.startsWith(PDFJS_ROOT + "/") || !existsSync(abs) || statSync(abs).isDirectory()) {
          return next();
        }
        res.setHeader("Content-Type", contentTypeFor(abs));
        createReadStream(abs).pipe(res);
      });
    },
    // Only fires during `vite build` (Rollup's bundle lifecycle — the dev
    // server never calls this), so `npm run dev`/`dev:browser` never pay this
    // copy cost and a Tauri build always gets dist/pdfjs alongside dist/.
    closeBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        copyDirRecursive(join(PDFJS_ROOT, dir), join("dist", "pdfjs", dir));
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [pdfjsAssetsPlugin()],

  // browser-mode-only static fixtures (R11, _workspace/01_r11.md §1) — e.g.
  // mock-assets/mock/vault/report.xlsx, served at "/mock/vault/report.xlsx"
  // so the mock convertFileSrc's identity passthrough + a real `fetch` can
  // return real bytes without a Tauri asset-protocol backend. `false` in
  // every other mode, so this directory is NEVER bundled into a Tauri build.
  publicDir: mode === "browser" ? "mock-assets" : false,

  // `--mode browser`: run frontend with no Rust backend by swapping the Tauri
  // IPC module for an in-memory mock (src/mocks/tauri-core.ts). Tauri builds untouched.
  resolve:
    mode === "browser"
      ? {
          alias: {
            "@tauri-apps/api/core": fileURLToPath(
              new URL("./src/mocks/tauri-core.ts", import.meta.url),
            ),
            "@tauri-apps/api/event": fileURLToPath(
              new URL("./src/mocks/tauri-event.ts", import.meta.url),
            ),
            "@tauri-apps/api/app": fileURLToPath(
              new URL("./src/mocks/tauri-app.ts", import.meta.url),
            ),
            "@tauri-apps/api/path": fileURLToPath(
              new URL("./src/mocks/tauri-path.ts", import.meta.url),
            ),
          },
        }
      : undefined,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  //
  //    PORT SPLIT (2026-07-14): `tauri dev` and the CDP golden harness
  //    (`dev:browser`) both wanted 1420, so running the real app while a golden
  //    session was up died with "Port 1420 is already in use" — and the fix
  //    people reach for (kill the other one) makes the two harnesses mutually
  //    exclusive for no reason. They get separate ports instead.
  //    1420 is pinned by tauri.conf.json's `devUrl` and can't move; the browser
  //    harness takes 1430 (NOT 1421 — that's this config's own HMR port when
  //    TAURI_DEV_HOST is set). The golden scripts default to 1430 to match.
  //    strictPort stays true on both: a port collision must fail loudly, not
  //    silently move the server somewhere the goldens aren't looking.
  server: {
    port: mode === "browser" ? 1430 : 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
