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
});
