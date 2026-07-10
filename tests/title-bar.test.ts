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
  installLeftGroupRehoming,
} from "../src/title-bar";

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

// M6 rehome (_workspace/01_architect_design.md + plan): the left command
// group lives in whichever rail is open, or the title-bar when none is.
// rehomeLeftCommandGroup is the pure "where does it go" rule;
// installLeftGroupRehoming is the MutationObserver wiring on top of it.
describe("left-command-group rehoming", () => {
  function mk(id: string): HTMLElement {
    const e = document.createElement("button");
    e.dataset.id = id;
    return e;
  }

  function leftGroupParts() {
    return { explorer: mk("explorer"), recent: mk("recent"), outline: mk("outline"), openPath: mk("openPath") };
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
      parts.explorer.focus();
      expect(document.activeElement).toBe(parts.explorer);
      rehomeLeftCommandGroup(group, bar, strip);
      expect(document.activeElement).toBe(parts.explorer);
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
      expect(group.childNodes.length).toBe(4); // no duplicate append
    });
  });

  describe("installLeftGroupRehoming", () => {
    /** An aside with a sidebar-top-strip already prepended (main.ts's real
     *  shape: aside.prepend(createSidebarTopStrip())), starting hidden (rail
     *  closed). */
    function makeAside(): HTMLElement {
      const aside = document.createElement("aside");
      aside.hidden = true;
      aside.append(createSidebarTopStrip());
      return aside;
    }

    function setup() {
      const bar = barWithSpacerAnchor();
      const group = createLeftCommandGroup(leftGroupParts());
      const recentAside = makeAside();
      const explorerAside = makeAside();
      const outlineAside = makeAside();
      installLeftGroupRehoming({ asides: [recentAside, explorerAside, outlineAside], bar, group });
      return { bar, group, recentAside, explorerAside, outlineAside };
    }

    it("initial placement: every aside hidden -> the group starts in the bar", () => {
      const { bar, group } = setup();
      expect(group.parentElement).toBe(bar);
    });

    it("opening a rail moves the group into that rail's strip", async () => {
      const { group, explorerAside } = setup();
      explorerAside.hidden = false;
      await Promise.resolve(); // MutationObserver delivers on the microtask queue
      expect(group.parentElement).toBe(explorerAside.querySelector(".sidebar-top-strip"));
    });

    it("switching rails in one task batches into a single rehome, landing in the new rail", async () => {
      const { group, explorerAside, outlineAside } = setup();
      explorerAside.hidden = false;
      await Promise.resolve();
      // Same synchronous task: A closes, B opens — one MutationObserver
      // delivery covering both flips, group lands only in B's strip.
      explorerAside.hidden = true;
      outlineAside.hidden = false;
      await Promise.resolve();
      expect(group.parentElement).toBe(outlineAside.querySelector(".sidebar-top-strip"));
    });

    it("closing the last open rail returns the group to the bar, before the spacer", async () => {
      const { bar, group, explorerAside } = setup();
      explorerAside.hidden = false;
      await Promise.resolve();
      explorerAside.hidden = true;
      await Promise.resolve();
      expect(group.parentElement).toBe(bar);
      expect(group.nextElementSibling?.classList.contains("title-spacer")).toBe(true);
    });
  });
});
