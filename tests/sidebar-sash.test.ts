import { describe, it, expect, beforeEach, vi } from "vitest";

// systemTheme() (pulled in transitively via settings/app) reads matchMedia;
// setup.ts already stubs a default, but keep this local for clarity/isolation
// with other settings-app tests that stub a specific value.
beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  document.documentElement.style.removeProperty("--sidebar-width");
});

describe("clampSidebarWidth", () => {
  it("passes a value already inside the range through unchanged", async () => {
    const { clampSidebarWidth } = await import("../src/settings/app");
    expect(clampSidebarWidth(240, 1200)).toBe(240);
  });

  it("clamps up to the 160 floor", async () => {
    const { clampSidebarWidth } = await import("../src/settings/app");
    expect(clampSidebarWidth(100, 1200)).toBe(160);
  });

  it("clamps down to the 480 absolute ceiling", async () => {
    const { clampSidebarWidth } = await import("../src/settings/app");
    expect(clampSidebarWidth(900, 1200)).toBe(480);
  });

  it("clamps down to half the viewport when that is tighter than 480", async () => {
    const { clampSidebarWidth } = await import("../src/settings/app");
    expect(clampSidebarWidth(500, 800)).toBe(400);
  });
});

describe("createSidebarSash: DOM shape", () => {
  it("renders a separator with the expected ARIA wiring", async () => {
    const { createSidebarSash } = await import("../src/sidebar/sash");
    const sash = createSidebarSash();
    expect(sash.el.getAttribute("role")).toBe("separator");
    expect(sash.el.getAttribute("aria-orientation")).toBe("vertical");
    expect(sash.el.getAttribute("tabindex")).toBe("0");
    expect(sash.el.getAttribute("aria-label")).toBe("사이드바 폭 조절");
    expect(sash.el.getAttribute("aria-valuemin")).toBe("160");
    expect(sash.el.getAttribute("aria-valuemax")).toBe("480");
    expect(sash.el.getAttribute("aria-valuenow")).toBe("240"); // default width
  });
});

describe("createSidebarSash: drag = preview, release = commit", () => {
  function pointer(type: string, clientX: number, extra: Partial<PointerEventInit> = {}) {
    return new PointerEvent(type, { clientX, pointerId: 1, bubbles: true, cancelable: true, ...extra });
  }

  it("pointermove writes the transient CSS var without touching the setting; pointerup commits once", async () => {
    const { createSidebarSash } = await import("../src/sidebar/sash");
    const { sidebarWidthSetting } = await import("../src/settings/app");
    const startWidth = sidebarWidthSetting.get(); // 240
    const sash = createSidebarSash();

    sash.el.dispatchEvent(pointer("pointerdown", 0));
    sash.el.dispatchEvent(pointer("pointermove", 60));

    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe(
      `${startWidth + 60}px`,
    );
    expect(sidebarWidthSetting.get()).toBe(startWidth); // still the pre-drag value — no commit yet

    sash.el.dispatchEvent(pointer("pointerup", 60));
    expect(sidebarWidthSetting.get()).toBe(startWidth + 60); // exactly one commit, on release
  });

  it("clamps the drag at the 160 floor — the var/commit never goes below it", async () => {
    const { createSidebarSash } = await import("../src/sidebar/sash");
    const { sidebarWidthSetting } = await import("../src/settings/app");
    const sash = createSidebarSash();

    sash.el.dispatchEvent(pointer("pointerdown", 0));
    sash.el.dispatchEvent(pointer("pointermove", -10000)); // far past the floor
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("160px");

    sash.el.dispatchEvent(pointer("pointerup", -10000));
    expect(sidebarWidthSetting.get()).toBe(160);
  });

  it("ignores a non-primary button (right/middle-click never starts a drag)", async () => {
    const { createSidebarSash } = await import("../src/sidebar/sash");
    const { sidebarWidthSetting } = await import("../src/settings/app");
    const sash = createSidebarSash();

    sash.el.dispatchEvent(pointer("pointerdown", 0, { button: 2 })); // right-click
    expect(sash.el.classList.contains("is-dragging")).toBe(false);
    // pointermove after a non-primary down does nothing (listener never attached)
    sash.el.dispatchEvent(pointer("pointermove", 60));
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("");
    expect(sidebarWidthSetting.get()).toBe(240);
  });

  it("toggles .is-dragging on pointerdown and off on pointerup", async () => {
    const { createSidebarSash } = await import("../src/sidebar/sash");
    const sash = createSidebarSash();

    sash.el.dispatchEvent(pointer("pointerdown", 0));
    expect(sash.el.classList.contains("is-dragging")).toBe(true);

    sash.el.dispatchEvent(pointer("pointerup", 0));
    expect(sash.el.classList.contains("is-dragging")).toBe(false);
  });

  it("aria-valuenow tracks the committed setting, not the mid-drag transient var", async () => {
    const { createSidebarSash } = await import("../src/sidebar/sash");
    const sash = createSidebarSash();

    sash.el.dispatchEvent(pointer("pointerdown", 0));
    sash.el.dispatchEvent(pointer("pointermove", 60));
    expect(sash.el.getAttribute("aria-valuenow")).toBe("240"); // unchanged mid-drag

    sash.el.dispatchEvent(pointer("pointerup", 60));
    expect(sash.el.getAttribute("aria-valuenow")).toBe("300"); // updated on commit
  });
});

describe("createSidebarSash: keyboard", () => {
  function key(type: string, k: string) {
    return new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true });
  }

  it("ArrowRight commits +16px immediately", async () => {
    const { createSidebarSash } = await import("../src/sidebar/sash");
    const { sidebarWidthSetting } = await import("../src/settings/app");
    const sash = createSidebarSash();
    const start = sidebarWidthSetting.get();

    sash.el.dispatchEvent(key("keydown", "ArrowRight"));
    expect(sidebarWidthSetting.get()).toBe(start + 16);
  });

  it("ArrowLeft commits -16px immediately", async () => {
    const { createSidebarSash } = await import("../src/sidebar/sash");
    const { sidebarWidthSetting } = await import("../src/settings/app");
    const sash = createSidebarSash();
    const start = sidebarWidthSetting.get();

    sash.el.dispatchEvent(key("keydown", "ArrowLeft"));
    expect(sidebarWidthSetting.get()).toBe(start - 16);
  });

  it("ignores unrelated keys", async () => {
    const { createSidebarSash } = await import("../src/sidebar/sash");
    const { sidebarWidthSetting } = await import("../src/settings/app");
    const sash = createSidebarSash();
    const start = sidebarWidthSetting.get();

    sash.el.dispatchEvent(key("keydown", "Enter"));
    expect(sidebarWidthSetting.get()).toBe(start);
  });
});
