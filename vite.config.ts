import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({

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
