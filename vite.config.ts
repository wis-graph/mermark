import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({

  // `--mode browser`: run frontend with no Rust backend by swapping the Tauri
  // IPC module for an in-memory mock (src/mocks/tauri-core.ts). Tauri builds untouched.
  resolve:
    mode === "browser"
      ? {
          alias: {
            "@tauri-apps/api/core": fileURLToPath(
              new URL("./src/mocks/tauri-core.ts", import.meta.url),
            ),
          },
        }
      : undefined,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
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
