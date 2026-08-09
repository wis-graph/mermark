import { beforeEach, describe, expect, it, vi } from "vitest";

describe("global theme persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("restores the persisted global preset when the theme document is absent", async () => {
    localStorage.setItem("mermark.theme", "light");

    const { themeJsonSetting, themeSetting } = await import("../src/settings/app");

    expect(themeSetting.get()).toBe("light");
    expect(themeJsonSetting.get().name).toBe("light");
  });

  it("stores the global theme independently from workspace state", async () => {
    const { themeSetting } = await import("../src/settings/app");

    themeSetting.set("claude");
    localStorage.setItem("mermark.workspaceState", JSON.stringify({ workspaces: [], vaults: [] }));

    expect(localStorage.getItem("mermark.theme")).toBe("claude");
    expect(JSON.parse(localStorage.getItem("mermark.workspaceState") ?? "null")).not.toHaveProperty("theme");
  });

  it("restores the same global theme on screen after vault switching and restart", async () => {
    const { WorkspaceStore } = await import("../src/workspace/workspace-state");
    const { themeSetting } = await import("../src/settings/app");
    const { applyTheme } = await import("../src/theme");
    const store = new WorkspaceStore();

    store.registerVault("/tmp/mermark-theme-a", "A");
    const second = store.registerVault("/tmp/mermark-theme-b", "B");
    store.selectVault(second.vaultId);
    themeSetting.set("claude");
    themeSetting.bind(applyTheme);

    expect(document.documentElement.dataset.theme).toBe("claude");
    expect(JSON.parse(localStorage.getItem("mermark.workspaceState") ?? "null")).not.toHaveProperty("theme");

    vi.resetModules();
    const restarted = await import("../src/settings/app");
    restarted.themeSetting.bind(applyTheme);

    expect(restarted.themeSetting.get()).toBe("claude");
    expect(document.documentElement.dataset.theme).toBe("claude");
    expect(JSON.parse(localStorage.getItem("mermark.workspaceState") ?? "null")).not.toHaveProperty("theme");
  });
});
