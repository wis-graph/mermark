import { describe, it, expect } from "vitest";
import { createTitleBar, arrangeTitleBar, createLeftCommandGroup } from "../src/title-bar";

// The title-bar layout contract (M6 rehome, _workspace/01_architect_design.md):
// TitleBarParts is now {leftGroup, mode, theme, settings} — the four left
// buttons (탐색기·최근·목차·경로열기) are pre-assembled by createLeftCommandGroup
// into ONE .left-command-group, so their internal order lives in exactly one
// place (there), not also duplicated in an arrangeTitleBar parts list. Left→
// right is leftGroup · [drag spacer] · mode · theme · settings, with the
// win/linux window-controls cluster ALWAYS last (OS convention). M5: the
// 즐겨찾기 title-bar button is gone (favorites is now a permanently hosted
// section inside the explorer's own aside, not an independent mutually-
// exclusive view — see favorites/favorites-panel.ts). arrangeTitleBar is the
// single ordering rule; this pins it with plain elements (no editor boot
// needed), mirroring status-bar-order.test.ts's mk() pattern.

function mk(id: string): HTMLElement {
  const e = document.createElement("button");
  e.dataset.id = id;
  return e;
}

function leftGroupParts() {
  return { explorer: mk("explorer"), recent: mk("recent"), outline: mk("outline"), openPath: mk("openPath") };
}

function rightParts() {
  return { mode: mk("mode"), theme: mk("theme"), settings: mk("settings") };
}

describe("createLeftCommandGroup", () => {
  it("wraps the four buttons, in canonical order, with its own drag-region", () => {
    const group = createLeftCommandGroup(leftGroupParts());
    expect(group.className).toBe("left-command-group");
    expect(group.hasAttribute("data-tauri-drag-region")).toBe(true);
    const ids = [...group.children].map((c) => (c as HTMLElement).dataset.id);
    expect(ids).toEqual(["explorer", "recent", "outline", "openPath"]);
  });
});

describe("arrangeTitleBar", () => {
  it("lays the chrome out left→right in the canonical order (mac: no window-controls)", () => {
    const { el: bar } = createTitleBar({ platform: "mac" });
    const leftGroup = createLeftCommandGroup(leftGroupParts());
    const { mode, theme, settings } = rightParts();
    arrangeTitleBar(bar, { leftGroup, mode, theme, settings });
    const children = [...bar.children] as HTMLElement[];
    expect(children[0]).toBe(leftGroup);
    expect(children[1].classList.contains("title-spacer")).toBe(true);
    expect(children[2]).toBe(mode);
    expect(children[3]).toBe(theme);
    expect(children[4]).toBe(settings);
    // no "favorites" entry anywhere (M5 removal) — leftGroup's own children
    // are the only place button identities live now.
    const leftIds = [...leftGroup.children].map((c) => (c as HTMLElement).dataset.id);
    expect(leftIds).not.toContain("favorites");
  });

  it("the drag spacer sits between the left group and the right cluster, and carries drag-region", () => {
    const { el: bar } = createTitleBar({ platform: "mac" });
    const leftGroup = createLeftCommandGroup(leftGroupParts());
    const { mode, theme, settings } = rightParts();
    arrangeTitleBar(bar, { leftGroup, mode, theme, settings });
    const children = [...bar.children] as HTMLElement[];
    const spacerIndex = children.findIndex((c) => c.classList.contains("title-spacer"));
    expect(spacerIndex).toBeGreaterThan(children.indexOf(leftGroup));
    expect(spacerIndex).toBeLessThan(children.indexOf(mode));
    expect(children[spacerIndex].hasAttribute("data-tauri-drag-region")).toBe(true);
  });

  it("win/linux: every part lands before .window-controls, which stays the last child", () => {
    const { el: bar } = createTitleBar({ platform: "other" });
    // createTitleBar already appended .window-controls for non-mac platforms.
    expect(bar.lastElementChild?.classList.contains("window-controls")).toBe(true);
    const leftGroup = createLeftCommandGroup(leftGroupParts());
    const { mode, theme, settings } = rightParts();
    arrangeTitleBar(bar, { leftGroup, mode, theme, settings });
    expect(bar.lastElementChild?.classList.contains("window-controls")).toBe(true);
    const children = [...bar.children] as HTMLElement[];
    const settingsIndex = children.indexOf(settings);
    const themeIndex = children.indexOf(theme);
    const controlsIndex = children.findIndex((c) => c.classList.contains("window-controls"));
    expect(settingsIndex).toBeGreaterThan(themeIndex);
    expect(settingsIndex).toBeLessThan(controlsIndex);
    expect(controlsIndex).toBe(children.length - 1);
  });
});
