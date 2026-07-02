import { describe, it, expect } from "vitest";
import { createTitleBar, arrangeTitleBar } from "../src/title-bar";

// The title-bar layout contract (design M2 §1): left→right is
// 탐색기 · 최근 · 목차 · 경로열기 · [drag spacer] · 모드 · 테마 · ⚙, with the
// win/linux window-controls cluster ALWAYS last (OS convention). arrangeTitleBar
// is the single ordering rule; this pins it with plain elements (no editor boot
// needed), mirroring status-bar-order.test.ts's mk() pattern.

function mk(id: string): HTMLElement {
  const e = document.createElement("button");
  e.dataset.id = id;
  return e;
}

function parts() {
  return {
    explorer: mk("explorer"),
    recent: mk("recent"),
    outline: mk("outline"),
    openPath: mk("openPath"),
    mode: mk("mode"),
    theme: mk("theme"),
    settings: mk("settings"),
  };
}

describe("arrangeTitleBar", () => {
  it("lays the chrome out left→right in the canonical order (mac: no window-controls)", () => {
    const { el: bar } = createTitleBar({ platform: "mac" });
    arrangeTitleBar(bar, parts());
    const ids = [...bar.children].map((c) => (c as HTMLElement).dataset.id);
    expect(ids).toEqual(["explorer", "recent", "outline", "openPath", undefined, "mode", "theme", "settings"]);
    // openPath sits AFTER outline — the new grouping (differs from the old status-bar order).
    expect(ids.indexOf("openPath")).toBeGreaterThan(ids.indexOf("outline"));
  });

  it("the drag spacer sits between the left group and the right cluster", () => {
    const { el: bar } = createTitleBar({ platform: "mac" });
    arrangeTitleBar(bar, parts());
    const children = [...bar.children] as HTMLElement[];
    const spacerIndex = children.findIndex((c) => c.classList.contains("title-spacer"));
    expect(spacerIndex).toBeGreaterThan(-1);
    expect(spacerIndex).toBeGreaterThan(children.findIndex((c) => c.dataset.id === "openPath"));
    expect(spacerIndex).toBeLessThan(children.findIndex((c) => c.dataset.id === "mode"));
    const spacer = children[spacerIndex];
    expect(spacer.hasAttribute("data-tauri-drag-region")).toBe(true);
  });

  it("win/linux: every part lands before .window-controls, which stays the last child", () => {
    const { el: bar } = createTitleBar({ platform: "other" });
    // createTitleBar already appended .window-controls for non-mac platforms.
    expect(bar.lastElementChild?.classList.contains("window-controls")).toBe(true);
    arrangeTitleBar(bar, parts());
    expect(bar.lastElementChild?.classList.contains("window-controls")).toBe(true);
    const children = [...bar.children] as HTMLElement[];
    const settingsIndex = children.findIndex((c) => c.dataset.id === "settings");
    const themeIndex = children.findIndex((c) => c.dataset.id === "theme");
    const controlsIndex = children.findIndex((c) => c.classList.contains("window-controls"));
    expect(settingsIndex).toBeGreaterThan(themeIndex);
    expect(settingsIndex).toBeLessThan(controlsIndex);
    expect(controlsIndex).toBe(children.length - 1);
  });
});
