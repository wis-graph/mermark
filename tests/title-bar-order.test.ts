import { describe, it, expect } from "vitest";
import {
  createTitleBar,
  arrangeTitleBar,
  createLeftCommandGroup,
  createTitleSlot,
  createViewerSlot,
  createDocName,
  groupFitsWithin,
} from "../src/chrome/title-bar";

// The title-bar layout contract (M6 rehome, _workspace/01_architect_design.md;
// R9, _workspace/01_architecture.md): TitleBarParts is {leftGroup, mode,
// theme, settings} — leftGroup is ONE pre-assembled .left-command-group so
// its internal order lives in exactly one place, not duplicated in an
// arrangeTitleBar parts list. Left→right is leftGroup · [drag spacer] · mode ·
// theme · settings, with the win/linux window-controls cluster ALWAYS last
// R9: createLeftCommandGroup now wraps only `openPath` — the 탐색기·최근·
//목차 buttons are inserted by sidebar/registry.ts's registerSidebarPanel/
// installSidebarPanels at runtime, in registration order, just before
// openPath. That "registration order + install → group order" contract is
// asserted in tests/sidebar-panels.test.ts (T3), not here — this file only
// pins arrangeTitleBar's own ordering rule, mirroring
// status-bar-order.test.ts's mk() pattern.

function mk(id: string): HTMLElement {
  const e = document.createElement("button");
  e.dataset.id = id;
  return e;
}

function rightParts() {
  return { mode: mk("mode"), theme: mk("theme"), settings: mk("settings") };
}

describe("createLeftCommandGroup", () => {
  it("D1: an EMPTY group (panel toggles only, added by sidebar/registry.ts) with its own drag-region; openPath is title-bar-owned", () => {
    const group = createLeftCommandGroup();
    expect(group.className).toBe("left-command-group");
    expect(group.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(group.children.length).toBe(0);
  });
});

describe("groupFitsWithin (the 'rail only if it fits' rule)", () => {
  it("fits when the group is no wider than the strip's content box", () => {
    expect(groupFitsWithin(148, 154)).toBe(true);
    expect(groupFitsWithin(148, 148)).toBe(true);
    expect(groupFitsWithin(178, 154)).toBe(false);
  });
});

describe("arrangeTitleBar", () => {
  it("lays the chrome out left→right in the canonical order (mac: no window-controls)", () => {
    const { el: bar } = createTitleBar({ platform: "mac" });
    const leftGroup = createLeftCommandGroup();
    const openPath = mk("openPath");
    const docName = createDocName();
    const { mode, theme, settings } = rightParts();
    const titleSlot = createTitleSlot();
    const viewerSlot = createViewerSlot();
    arrangeTitleBar(bar, { leftGroup, openPath, titleSlot, docName, viewerSlot, mode, theme, settings });
    const children = [...bar.children] as HTMLElement[];
    // D1: leftGroup · openPath · titleSlot · docName · spacer · viewerSlot · mode · theme · settings
    expect(children[0]).toBe(leftGroup);
    expect(children[1]).toBe(openPath); // title-bar-owned, never rehomed into a rail
    expect(children[2]).toBe(titleSlot); // viewer caption (empty until a viewer opens)
    expect(children[3]).toBe(docName); // document filename
    expect(children[4].classList.contains("title-spacer")).toBe(true);
    expect(children[5]).toBe(viewerSlot); // viewer controls, left of the app cluster
    expect(children[6]).toBe(mode);
    expect(children[7]).toBe(theme);
    expect(children[8]).toBe(settings);
    // no "favorites" entry anywhere (M5 removal) — leftGroup's own children
    // are the only place button identities live now.
    const leftIds = [...leftGroup.children].map((c) => (c as HTMLElement).dataset.id);
    expect(leftIds).not.toContain("favorites");
  });

  it("the drag spacer sits between the left group and the right cluster, and carries drag-region", () => {
    const { el: bar } = createTitleBar({ platform: "mac" });
    const leftGroup = createLeftCommandGroup();
    const openPath = mk("openPath");
    const docName = createDocName();
    const { mode, theme, settings } = rightParts();
    const titleSlot = createTitleSlot();
    const viewerSlot = createViewerSlot();
    arrangeTitleBar(bar, { leftGroup, openPath, titleSlot, docName, viewerSlot, mode, theme, settings });
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
    const leftGroup = createLeftCommandGroup();
    const openPath = mk("openPath");
    const docName = createDocName();
    const { mode, theme, settings } = rightParts();
    const titleSlot = createTitleSlot();
    const viewerSlot = createViewerSlot();
    arrangeTitleBar(bar, { leftGroup, openPath, titleSlot, docName, viewerSlot, mode, theme, settings });
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
