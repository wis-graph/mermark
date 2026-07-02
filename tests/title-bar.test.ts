import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// vi.mock precedent: tests/session-persistence.test.ts mocks @tauri-apps/api/window
// the same way — a plain object of spies returned by getCurrentWindow().
const winMock = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => winMock,
}));

import { createTitleBar } from "../src/title-bar";

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
});
