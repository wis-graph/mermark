import { describe, it, expect, beforeEach, vi } from "vitest";

describe("app settings", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    // systemTheme() reads matchMedia; matches:false → "dark"
    vi.stubGlobal("matchMedia", () => ({ matches: false }) as unknown as MediaQueryList);
  });

  it("themeSetting defaults to the system theme and persists under mermark.theme", async () => {
    const { themeSetting } = await import("../src/settings/app");
    expect(themeSetting.get()).toBe("dark");
    themeSetting.set("light");
    expect(localStorage.getItem("mermark.theme")).toBe("light");
  });

  it("themeSetting reads a saved preference over the system theme", async () => {
    localStorage.setItem("mermark.theme", "light");
    const { themeSetting } = await import("../src/settings/app");
    expect(themeSetting.get()).toBe("light");
  });

  it("modeSetting defaults to read and persists under mermark.mode", async () => {
    const { modeSetting } = await import("../src/settings/app");
    expect(modeSetting.get()).toBe("read");
    modeSetting.set("edit");
    expect(localStorage.getItem("mermark.mode")).toBe("edit");
  });

  it("modeSetting reads a saved edit preference", async () => {
    localStorage.setItem("mermark.mode", "edit");
    const { modeSetting } = await import("../src/settings/app");
    expect(modeSetting.get()).toBe("edit");
  });

  it("fontScaleSetting defaults to 1.0 and persists under mermark.fontScale", async () => {
    const { fontScaleSetting } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(1.0);
    fontScaleSetting.set(1.2);
    expect(localStorage.getItem("mermark.fontScale")).toBe("1.2");
  });

  it("fontScaleSetting reads a saved scale over the default", async () => {
    localStorage.setItem("mermark.fontScale", "1.5");
    const { fontScaleSetting } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(1.5);
  });

  it("fontScaleSetting clamps an out-of-range saved scale to the bounds", async () => {
    localStorage.setItem("mermark.fontScale", "5");
    const { fontScaleSetting } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(2.0); // MAX
  });

  it("fontScaleSetting clamps a below-min saved scale up to the floor", async () => {
    localStorage.setItem("mermark.fontScale", "0.1");
    const { fontScaleSetting } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(0.8); // MIN
  });

  it("fontScaleSetting falls back to the default on a corrupt saved scale", async () => {
    localStorage.setItem("mermark.fontScale", "abc");
    const { fontScaleSetting } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(1.0); // NaN → default
  });

  it("clampFontScale snaps to the bounds and the 0.1 step", async () => {
    const { clampFontScale } = await import("../src/settings/app");
    expect(clampFontScale(2.5)).toBe(2.0); // above MAX
    expect(clampFontScale(0.5)).toBe(0.8); // below MIN
    expect(clampFontScale(1.04)).toBe(1.0); // snaps down to step
    expect(clampFontScale(1.06)).toBe(1.1); // snaps up to step
  });

  it("zoomIn / zoomOut / resetZoom move the setting by the clamped step and persist", async () => {
    const { fontScaleSetting, zoomIn, zoomOut, resetZoom } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(1.0);

    zoomIn();
    expect(fontScaleSetting.get()).toBe(1.1);
    expect(localStorage.getItem("mermark.fontScale")).toBe("1.1"); // SSOT writer persists

    // clamp at MAX: spamming zoomIn stops at 2.0
    for (let i = 0; i < 20; i++) zoomIn();
    expect(fontScaleSetting.get()).toBe(2.0);

    resetZoom();
    expect(fontScaleSetting.get()).toBe(1.0);

    zoomOut();
    expect(fontScaleSetting.get()).toBe(0.9);

    // clamp at MIN: spamming zoomOut stops at 0.8
    for (let i = 0; i < 20; i++) zoomOut();
    expect(fontScaleSetting.get()).toBe(0.8);
  });

  it("applyFontScale writes the scale to the --font-scale CSS var", async () => {
    const { applyFontScale } = await import("../src/theme");
    applyFontScale(1.4);
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.4");
  });

  it("themeJsonSetting defaults to the system preset and persists under mermark.themeJson", async () => {
    const { themeJsonSetting } = await import("../src/settings/app");
    const { builtInTheme } = await import("../src/settings/theme-schema");
    // matchMedia matches:false → systemTheme() = "dark"
    expect(themeJsonSetting.get()).toEqual(builtInTheme("dark"));
    const light = builtInTheme("light");
    themeJsonSetting.set(light);
    expect(localStorage.getItem("mermark.themeJson")).toBe(JSON.stringify(light, null, 2));
  });

  it("themeJsonSetting parses a saved JSON theme on construction", async () => {
    const { builtInTheme, serializeTheme } = await import("../src/settings/theme-schema");
    localStorage.setItem("mermark.themeJson", serializeTheme(builtInTheme("light")));
    const { themeJsonSetting } = await import("../src/settings/app");
    expect(themeJsonSetting.get()).toEqual(builtInTheme("light"));
  });

  it("themeJsonSetting falls back to the default on a corrupt saved JSON", async () => {
    localStorage.setItem("mermark.themeJson", "{ broken");
    const { themeJsonSetting } = await import("../src/settings/app");
    const { builtInTheme } = await import("../src/settings/theme-schema");
    expect(themeJsonSetting.get()).toEqual(builtInTheme("dark")); // parse → null → default
  });

  it("loadPreset writes BOTH themeJsonSetting and themeSetting (coherence in one place)", async () => {
    const { themeSetting, themeJsonSetting, loadPreset } = await import("../src/settings/app");
    const { builtInTheme } = await import("../src/settings/theme-schema");
    loadPreset("light");
    expect(themeSetting.get()).toBe("light");
    expect(themeJsonSetting.get()).toEqual(builtInTheme("light"));
  });

  it("themeSetting still defaults/persists after migration to the registry", async () => {
    const { themeSetting } = await import("../src/settings/app");
    expect(themeSetting.get()).toBe("dark"); // unchanged from pre-migration
    themeSetting.set("light");
    expect(localStorage.getItem("mermark.theme")).toBe("light");
  });

  it("themeSetting appears in the registry under the 테마 group", async () => {
    await import("../src/settings/app");
    const { groups } = await import("../src/settings/registry");
    const theme = groups().find((g) => g.name === "테마");
    expect(theme).toBeDefined();
    expect(theme!.entries.some((e) => e.ui.label === "테마 JSON")).toBe(true);
  });

  it("declares the typography settings with defaults and persistence", async () => {
    const app = await import("../src/settings/app");
    expect(app.fontSizeSetting.get()).toBe(16); // 1rem base
    expect(app.lineHeightSetting.get()).toBe(1.6);
    expect(app.readingWidthSetting.get()).toBe(820);
    app.fontSizeSetting.set(18);
    expect(localStorage.getItem("mermark.fontSize")).toBe("18");
  });

  it("declares editor + mermaid settings with defaults", async () => {
    const app = await import("../src/settings/app");
    expect(app.defaultModeSetting.get()).toBe("read");
    expect(app.conflictPolicySetting.get()).toBe("pause");
    expect(app.panZoomSetting.get()).toBe("on");
    expect(app.themeForceSetting.get()).toBe("follow");
  });

  it("seedSessionMode seeds the live mode from the boot default (defaultMode=edit → mode=edit)", async () => {
    localStorage.setItem("mermark.defaultMode", "edit");
    const { modeSetting, defaultModeSetting, seedSessionMode } = await import("../src/settings/app");
    expect(defaultModeSetting.get()).toBe("edit");
    expect(modeSetting.get()).toBe("read"); // unseeded default
    seedSessionMode();
    expect(modeSetting.get()).toBe("edit"); // boot mode = the panel default
  });

  it("seedSessionMode leaves modeSetting as the live session value after boot (toggle ≠ default)", async () => {
    localStorage.setItem("mermark.defaultMode", "read");
    const { modeSetting, defaultModeSetting, seedSessionMode } = await import("../src/settings/app");
    seedSessionMode();
    expect(modeSetting.get()).toBe("read");
    modeSetting.set("edit"); // session ⌘E toggle
    expect(modeSetting.get()).toBe("edit");
    expect(defaultModeSetting.get()).toBe("read"); // boot source untouched by the toggle
  });

  it("renders all five categories in the registry (Theme/Typography/Editor/Mermaid/Plugins)", async () => {
    await import("../src/settings/app");
    const { groups } = await import("../src/settings/registry");
    const names = groups().map((g) => g.name);
    expect(names).toEqual(["테마", "타이포그래피", "에디터", "Mermaid", "플러그인"]);
  });
});
