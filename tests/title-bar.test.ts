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

  function leftGroupParts() {
    return { openPath: mk("openPath") };
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
      const group = createLeftCommandGroup(leftGroupParts());
      const strip = createSidebarTopStrip();
      rehomeLeftCommandGroup(group, bar, strip);
      expect(group.parentElement).toBe(strip);
    });

    it("strip null: the group returns to the bar, just before .title-spacer", () => {
      const bar = barWithSpacerAnchor();
      const group = createLeftCommandGroup(leftGroupParts());
      const strip = createSidebarTopStrip();
      strip.append(group); // starts homed in a strip
      rehomeLeftCommandGroup(group, bar, null);
      const spacer = bar.querySelector(".title-spacer");
      expect(group.parentElement).toBe(bar);
      expect(group.nextElementSibling).toBe(spacer);
    });

    it("re-focuses a button that had focus before the move", () => {
      const bar = barWithSpacerAnchor();
      const parts = leftGroupParts();
      const group = createLeftCommandGroup(parts);
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
      const group = createLeftCommandGroup(leftGroupParts());
      rehomeLeftCommandGroup(group, bar, null);
      const parentBefore = group.parentElement;
      const nextBefore = group.nextElementSibling;
      rehomeLeftCommandGroup(group, bar, null);
      expect(group.parentElement).toBe(parentBefore);
      expect(group.nextElementSibling).toBe(nextBefore);
    });

    it("is idempotent: re-calling with the same (bar, strip) leaves parent unchanged", () => {
      const bar = barWithSpacerAnchor();
      const group = createLeftCommandGroup(leftGroupParts());
      const strip = createSidebarTopStrip();
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
