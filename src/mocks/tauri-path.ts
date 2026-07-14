// Browser-only mock for @tauri-apps/api/path.
// Injected via Vite alias ONLY in `--mode browser` (see vite.config.ts), the
// same pattern tauri-core.ts / tauri-event.ts / tauri-app.ts already use.
//
// Root cause this fixes (03_baseline.md, R9 QA pass): main.ts's
// initDefaultFavorites() awaits homeDir()/documentDir() on every boot. The
// real @tauri-apps/api/path package resolves those through its own `invoke`
// (same "bypasses the @tauri-apps/api/core alias" issue tauri-app.ts's header
// documents for getVersion) — under `--mode browser` there is no
// __TAURI_INTERNALS__, so `invoke` is undefined and the call throws
// "Cannot read properties of undefined (reading 'invoke')" on EVERY page
// load. That console error alone flips several golden scripts' `allPass`
// (they gate on `errors.length === 0`) even though every individual metric
// they measure is healthy — a false-negative gate nobody trusts. Giving this
// whole specifier a browser-mode replacement (rather than try/catching inside
// main.ts) actually closes the hole instead of hiding it.
export async function homeDir(): Promise<string> {
  return "/mock/home";
}

export async function documentDir(): Promise<string> {
  return "/mock/home/Documents";
}
