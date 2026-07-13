// Guards the tour-08 fix (version-pane placeholder in browser mode): the
// browser mock for @tauri-apps/api/app must resolve getVersion() to the
// package.json version string, not leave the version-pane's "—" placeholder
// unresolved (see src/mocks/tauri-app.ts header for the root cause — the real
// @tauri-apps/api/app module isn't covered by the vite.config.ts browser alias).
import { describe, it, expect } from "vitest";
import { getVersion } from "../src/mocks/tauri-app";
import pkg from "../package.json";

describe("mocks/tauri-app getVersion", () => {
  it("resolves to the package.json version string", async () => {
    await expect(getVersion()).resolves.toBe(pkg.version);
  });
});
