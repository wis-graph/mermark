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
});
