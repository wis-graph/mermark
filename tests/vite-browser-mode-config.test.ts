// @vitest-environment node
//
// Node environment override (not the suite's default jsdom): dynamically
// importing vite.config.ts pulls Vite's esbuild-based TS transform into this
// test, and esbuild's runtime invariant check (`new TextEncoder().encode("")
// instanceof Uint8Array`) fails under jsdom's own TextEncoder — a realm
// mismatch unrelated to this test's actual assertion.
//
// D2 (_workspace/01_architect_design.md §4.2 H2): in `--mode browser`,
// `@tauri-apps/plugin-*` packages must NOT be pre-bundled by Vite's dep
// optimizer. Pre-bundling drags their `@tauri-apps/api/core` import into a
// SHARED chunk (node_modules/.vite/deps/chunk-*.js) that carries its own
// top-level copy of the alias target (src/mocks/tauri-core.ts) — a second
// module instance whose own top-level code overwrites `window.__mockInvoke`/
// `window.__mockCurrentWatchSession` with ITS OWN empty state, so any golden
// script reading those globals off `window` sees a disconnected mock the
// running app never touches. Excluding the plugins keeps their
// `@tauri-apps/api/core` import going through the SAME aliased URL the app
// itself resolves to (E6 in _workspace/probe/).
//
// This dynamically imports vite.config.ts via a NON-LITERAL path
// (`resolve(...)` result, not a string literal) so TypeScript's module
// resolution never statically pulls the config file into
// tsconfig.test.json's program — a literal `import("../vite.config.ts")`
// would drag in that file's two pre-existing, unrelated type errors
// (TS2578/TS2769) and break `npm run typecheck` for everything in tests/.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface BrowserModeConfig {
  optimizeDeps?: { exclude?: string[] };
}

async function loadBrowserModeConfig(): Promise<BrowserModeConfig> {
  const configPath = resolve(process.cwd(), "vite.config.ts");
  const mod = (await import(configPath)) as { default: (env: { mode: string; command: string }) => Promise<BrowserModeConfig> | BrowserModeConfig };
  return mod.default({ mode: "browser", command: "serve" });
}

function tauriPluginDeps(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => name.startsWith("@tauri-apps/plugin-"));
}

describe("vite.config.ts browser-mode dep optimization", () => {
  it("excludes every @tauri-apps/plugin-* dependency from optimizeDeps so their @tauri-apps/api/core import resolves to the SAME aliased mock instance the app uses", async () => {
    const pluginDeps = tauriPluginDeps();
    expect(pluginDeps.length).toBeGreaterThan(0); // guards against an empty derivation silently passing

    const config = await loadBrowserModeConfig();

    for (const name of pluginDeps) {
      expect(config.optimizeDeps?.exclude ?? []).toContain(name);
    }
  });
});
