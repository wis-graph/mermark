import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// vi.mock precedent: tests/session-persistence.test.ts mocks @tauri-apps/api/window
// the same way — a plain object of spies returned by getCurrentWindow().
const winMock = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => winMock,
}));

import {
  createTitleBar,
  createSidebarTopStrip,
  createLeftCommandGroup,
  rehomeLeftCommandGroup,
  createTitleSlot,
  createDocName,
  renderDocName,
} from "../src/chrome/title-bar";

describe("title-bar", () => {
  beforeEach(() => {
    winMock.minimize.mockClear();
    winMock.toggleMaximize.mockClear();
    winMock.close.mockClear();
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("carries the drag-region contract on the strip itself", () => {
    const { el } = createTitleBar({ platform: "other" });
    expect(el.className).toContain("title-bar");
    expect(el.hasAttribute("data-tauri-drag-region")).toBe(true);
  });

  it("mac: inset class, no window-controls, no buttons", () => {
    const { el } = createTitleBar({ platform: "mac" });
    expect(el.classList.contains("mac")).toBe(true);
    expect(el.querySelector(".window-controls")).toBeNull();
    expect(el.querySelectorAll("button").length).toBe(0);
  });

  it("win/linux: no mac inset, three window-control buttons with labels", () => {
    const { el } = createTitleBar({ platform: "other" });
    expect(el.classList.contains("mac")).toBe(false);
    const controls = el.querySelector(".window-controls");
    expect(controls).not.toBeNull();
    const buttons = controls!.querySelectorAll("button");
    expect(buttons.length).toBe(3);
    const labels = Array.from(buttons).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["최소화", "최대화", "닫기"]);
  });

  it("window buttons call minimize/toggleMaximize/close exactly once under Tauri", () => {
    (window as any).__TAURI_INTERNALS__ = {};
    const { el } = createTitleBar({ platform: "other" });
    const buttons = el.querySelectorAll(".window-controls button");
    (buttons[0] as HTMLButtonElement).click();
    (buttons[1] as HTMLButtonElement).click();
    (buttons[2] as HTMLButtonElement).click();
    expect(winMock.minimize).toHaveBeenCalledTimes(1);
    expect(winMock.toggleMaximize).toHaveBeenCalledTimes(1);
    // close() — not destroy() — so main.ts's onCloseRequested autosave
    // interceptor stays on the path.
    expect(winMock.close).toHaveBeenCalledTimes(1);
  });

  it("window buttons no-op (no throw, no mock calls) outside a Tauri runtime", () => {
    const { el } = createTitleBar({ platform: "other" });
    const buttons = el.querySelectorAll(".window-controls button");
    expect(() => {
      (buttons[0] as HTMLButtonElement).click();
      (buttons[1] as HTMLButtonElement).click();
      (buttons[2] as HTMLButtonElement).click();
    }).not.toThrow();
    expect(winMock.minimize).not.toHaveBeenCalled();
    expect(winMock.toggleMaximize).not.toHaveBeenCalled();
    expect(winMock.close).not.toHaveBeenCalled();
  });

  it("window-control buttons do not carry the drag-region attribute (clicks pass through)", () => {
    const { el } = createTitleBar({ platform: "other" });
    const buttons = el.querySelectorAll(".window-controls button");
    expect(buttons.length).toBe(3);
    buttons.forEach((b) => expect(b.hasAttribute("data-tauri-drag-region")).toBe(false));
  });

  // Full-height sidebar rail (_workspace/01_architect_design.md): the rail's
  // window-chrome band. Same shape as createDragSpacer — a childless element
  // carrying data-tauri-drag-region (M1 rule: a child WITHOUT the attribute
  // is a dead zone for window dragging).
  it("createSidebarTopStrip: className, drag-region attribute, no children", () => {
    const strip = createSidebarTopStrip();
    expect(strip.className).toBe("sidebar-top-strip");
    expect(strip.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(strip.childElementCount).toBe(0);
  });

  // M6 rehome (_workspace/01_architect_design.md): the rail's window-chrome
  // band gets a platform inset too, same shape as createTitleBar's opts.
  it("createSidebarTopStrip: platform mac adds .mac, platform other does not", () => {
    expect(createSidebarTopStrip({ platform: "mac" }).classList.contains("mac")).toBe(true);
    expect(createSidebarTopStrip({ platform: "other" }).classList.contains("mac")).toBe(false);
  });
});

// M6 rehome (_workspace/01_architect_design.md + plan); R9
// (_workspace/01_architecture.md): the left command group lives in whichever
// rail is open, or the title-bar when none is. rehomeLeftCommandGroup is the
// pure "where does it go" rule — still title-bar.ts's job. The MutationObserver
// wiring on top of it (formerly installLeftGroupRehoming, a fixed asides[]
// array) moved to sidebar/registry.ts's installSidebarPanels — see
// tests/sidebar-panels.test.ts for that coverage (initial placement, open/
// switch/close, late registration).
describe("left-command-group rehoming", () => {
  function mk(id: string): HTMLElement {
    const e = document.createElement("button");
    e.dataset.id = id;
    return e;
  }

  /** A title-bar with a real `.title-spacer`-classed anchor, the same anchor
   *  rehomeLeftCommandGroup's title-bar branch inserts before. Doesn't need
   *  the real createDragSpacer (private to title-bar.ts) — only its class
   *  matters to the function under test. */
  function barWithSpacerAnchor(): HTMLElement {
    const { el: bar } = createTitleBar({ platform: "mac" });
    const spacer = document.createElement("span");
    spacer.className = "title-spacer";
    bar.append(spacer);
    return bar;
  }

  describe("rehomeLeftCommandGroup", () => {
    it("strip given: the group's parent becomes the strip", () => {
      const bar = barWithSpacerAnchor();
      const group = createLeftCommandGroup();
      const strip = createSidebarTopStrip();
      rehomeLeftCommandGroup(group, bar, strip);
      expect(group.parentElement).toBe(strip);
    });

    it("strip null: the group returns to the bar, just before .title-spacer", () => {
      const bar = barWithSpacerAnchor();
      const group = createLeftCommandGroup();
      const strip = createSidebarTopStrip();
      strip.append(group); // starts homed in a strip
      rehomeLeftCommandGroup(group, bar, null);
      const spacer = bar.querySelector(".title-spacer");
      expect(group.parentElement).toBe(bar);
      expect(group.nextElementSibling).toBe(spacer);
    });

    // REGRESSION (2026-07-19): when a viewer is open the bar also holds a
    // doc-title slot between the group and the spacer. Anchoring the rehome on
    // `.title-spacer` unconditionally re-inserted the group AFTER that title,
    // so opening a viewer visibly shoved the command icons rightward past the
    // filename. The group must stay at the START of the bar's flow.
    it("doc-title slot present: the group lands BEFORE it, not after (viewer-open case)", () => {
      const bar = barWithSpacerAnchor();
      const spacer = bar.querySelector(".title-spacer")!;
      const titleSlot = createTitleSlot();
      bar.insertBefore(titleSlot, spacer); // arrangeTitleBar's order: group · title · spacer
      const group = createLeftCommandGroup();
      const strip = createSidebarTopStrip();
      strip.append(group); // starts homed in a strip, as after closing a sidebar
      rehomeLeftCommandGroup(group, bar, null);
      expect(group.parentElement).toBe(bar);
      expect(group.nextElementSibling).toBe(titleSlot);
      // and idempotent in that arrangement too
      rehomeLeftCommandGroup(group, bar, null);
      expect(group.nextElementSibling).toBe(titleSlot);
    });

    // D1: openPath now lives in the bar right after the group, so the old
    // "anchor on titleSlot/spacer" rule would re-insert the group AFTER openPath.
    it("D1: the group returns to the very START of the bar's flow, before openPath", () => {
      const { el: bar } = createTitleBar({ platform: "mac" });
      const openPath = mk("openPath");
      const titleSlot = createTitleSlot();
      const spacer = document.createElement("span");
      spacer.className = "title-spacer";
      bar.append(openPath, titleSlot, spacer);
      const group = createLeftCommandGroup();
      const strip = createSidebarTopStrip();
      strip.append(group);
      rehomeLeftCommandGroup(group, bar, null);
      expect(bar.firstElementChild).toBe(group);
      expect(group.nextElementSibling).toBe(openPath);
      rehomeLeftCommandGroup(group, bar, null); // idempotent
      expect(bar.firstElementChild).toBe(group);
    });

    it("re-focuses a button that had focus before the move", () => {
      const bar = barWithSpacerAnchor();
      const group = createLeftCommandGroup();
      const parts = { openPath: mk("openPath") };
      group.append(parts.openPath);
      const strip = createSidebarTopStrip();
      document.body.append(bar, group, strip);
      parts.openPath.focus();
      expect(document.activeElement).toBe(parts.openPath);
      rehomeLeftCommandGroup(group, bar, strip);
      expect(document.activeElement).toBe(parts.openPath);
      bar.remove();
      group.remove();
      strip.remove();
    });

    it("is idempotent: re-calling with the same (bar, null) leaves parent/position unchanged", () => {
      const bar = barWithSpacerAnchor();
      const group = createLeftCommandGroup();
      rehomeLeftCommandGroup(group, bar, null);
      const parentBefore = group.parentElement;
      const nextBefore = group.nextElementSibling;
      rehomeLeftCommandGroup(group, bar, null);
      expect(group.parentElement).toBe(parentBefore);
      expect(group.nextElementSibling).toBe(nextBefore);
    });

    it("is idempotent: re-calling with the same (bar, strip) leaves parent unchanged", () => {
      const bar = barWithSpacerAnchor();
      const group = createLeftCommandGroup();
      const strip = createSidebarTopStrip();
      group.append(mk("toggle"));
      rehomeLeftCommandGroup(group, bar, strip);
      rehomeLeftCommandGroup(group, bar, strip);
      expect(group.parentElement).toBe(strip);
      expect(group.childNodes.length).toBe(1); // no duplicate append
    });
  });

  // installLeftGroupRehoming's MutationObserver-wiring coverage (initial
  // placement / open / switch / close / late registration) moved to
  // tests/sidebar-panels.test.ts's installSidebarPanels describe block — R9
  // replaced the fixed asides[] array with the dynamic panel registry.
});

// D1 🔴5: the document-name label. No dirty/unsaved marker by user decision —
// the app autosaves, so a marker would be noise (memory: no-unsaved-indicator).
describe("document name label", () => {
  it("createDocName: span.title-bar-doc-name carrying the drag-region (no dead zone)", () => {
    const el = createDocName();
    expect(el.tagName).toBe("SPAN");
    expect(el.className).toBe("title-bar-doc-name");
    expect(el.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(el.textContent).toBe("");
  });

  it("renderDocName shows the basename and the full path as tooltip", () => {
    const el = createDocName();
    renderDocName(el, "/a/b/demo.md");
    expect(el.textContent).toBe("demo.md");
    expect(el.title).toBe("/a/b/demo.md");
  });

  it("renderDocName with an empty file (welcome) clears label and tooltip", () => {
    const el = createDocName();
    renderDocName(el, "/a/b/demo.md");
    renderDocName(el, "");
    expect(el.textContent).toBe("");
    expect(el.title).toBe("");
  });

  it("no unsaved/dirty marker exists in the title-bar chrome source", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/chrome/title-bar.ts"), "utf8");
    expect(src).not.toMatch(/unsaved|dirty|미저장/i);
  });
});
