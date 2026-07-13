// Browser-only mock for @tauri-apps/api/app.
// Injected via Vite alias ONLY in `--mode browser` (see vite.config.ts).
//
// Root cause this fixes (2026-07-12 design-polish pass, tour-08): the real
// @tauri-apps/api/app's getVersion() resolves the real Tauri invoke through
// its own internal `./core` relative import, which bypasses the
// `@tauri-apps/api/core` alias entirely — so in `--mode browser` (no
// __TAURI_INTERNALS__) the call rejects and version-pane.ts's number span
// stays on its initial "—" placeholder. This module gives that whole
// `@tauri-apps/api/app` specifier a browser-mode replacement instead, so
// getVersion() resolves without touching invoke at all.
import pkg from "../../package.json";

export async function getVersion(): Promise<string> {
  return pkg.version;
}
