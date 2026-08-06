import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildColorInspector, presetDefaultFor } from "../src/settings/panel/color-inspector";
import { themeJsonSetting } from "../src/settings/app";
import { builtInTheme, serializeTheme } from "../src/settings/theme-schema";
import { themeTarget } from "../src/settings/panel/theme-preview";
import { hexToHsl } from "../src/settings/panel/color-math";

describe("Color inspector", () => {
  let host: HTMLElement;
  let inspector: ReturnType<typeof buildColorInspector>;

  beforeEach(() => {
    localStorage.clear();
    themeJsonSetting.set(builtInTheme("light"));
    host = document.createElement("div");
    document.body.appendChild(host);
    inspector = buildColorInspector(themeJsonSetting);
    host.appendChild(inspector.el);
  });

  afterEach(() => {
    inspector.teardown();
    host.remove();
    themeJsonSetting.set(builtInTheme("light"));
  });

  it("shows only the hint when nothing is selected", () => {
    expect(host.querySelector(".theme-inspector-hint")).not.toBeNull();
    expect(host.querySelector(".theme-inspector-head")).toBeNull();
  });

  // 2026-08 폴리시 리뷰 결정 5: 선택 직후 인스펙터 컨트롤이 뷰포트 밖으로
  // 밀려도 사용자가 알 수 있어야 한다 — setTarget이 매 선택마다 자신을
  // scrollIntoView 해야 한다.
  it("scrolls itself into view on every selection", () => {
    const spy = vi.fn();
    inspector.el.scrollIntoView = spy;
    inspector.setTarget(themeTarget("bold")!);
    expect(spy).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });

    spy.mockClear();
    inspector.setTarget(null);
    expect(spy).not.toHaveBeenCalled(); // clearing a selection has nothing new to reveal
  });

  it("selecting bold shows the label and both tabs; selecting a core color (bg) shows no tabs", () => {
    inspector.setTarget(themeTarget("bold")!);
    expect(host.querySelector(".theme-inspector-label")!.textContent).toBe("굵은 글자 (Bold)");
    expect(host.querySelectorAll(".theme-inspector-tab").length).toBe(2);

    inspector.setTarget(themeTarget("bg")!);
    expect(host.querySelectorAll(".theme-inspector-tab").length).toBe(0);
  });

  it("clicking a palette chip writes the chip's hex to the setting, preserving name", () => {
    inspector.setTarget(themeTarget("bold")!);
    const chip = host.querySelector<HTMLElement>('.theme-chip[aria-label="블루"]')!;
    chip.click();
    expect(themeJsonSetting.get().colors.bold).toBe("#1d6fb8");
    expect(themeJsonSetting.get().name).toBe("light"); // editing never renames the preset
  });

  it("the 없음 chip on the background tab clears the key (undefined + absent from JSON)", () => {
    inspector.setTarget(themeTarget("bold")!);
    // Switch to background tab.
    (host.querySelectorAll<HTMLElement>(".theme-inspector-tab")[1]!).click();
    const chip = host.querySelector<HTMLElement>('.theme-chip[aria-label="블루"]')!;
    chip.click();
    expect(themeJsonSetting.get().colors.boldBg).toBe("#1d6fb8");

    const none = host.querySelector<HTMLElement>(".theme-chip-none")!;
    none.click();
    expect(themeJsonSetting.get().colors.boldBg).toBeUndefined();
    expect(serializeTheme(themeJsonSetting.get())).not.toContain("boldBg");
  });

  it("highlight's background tab has NO 없음 chip (highlightBg is a required core key)", () => {
    inspector.setTarget(themeTarget("highlight")!);
    (host.querySelectorAll<HTMLElement>(".theme-inspector-tab")[1]!).click();
    expect(host.querySelector(".theme-chip-none")).toBeNull();
  });

  it("HSL sliders write a hex value derived from the drag, live-reflected in the hex readout", () => {
    inspector.setTarget(themeTarget("bold")!);
    const hueInput = host.querySelectorAll<HTMLInputElement>(".theme-inspector-slider-row input")[0]!;
    hueInput.value = "0";
    hueInput.dispatchEvent(new Event("input"));
    const written = themeJsonSetting.get().colors.bold!;
    expect(written).toMatch(/^#[0-9a-f]{6}$/);
  });

  // 2026-08 감사 반영 (blocker #1): color-inspector used to call the
  // structural render() (which destroys and recreates .theme-inspector-body,
  // sliders included) on EVERY color write. A real mouse drag over CDP
  // proved this breaks dragging: destroying an <input type=range> mid-drag
  // drops the browser's implicit pointer capture, so the drag died after its
  // first `input` event (value froze at the first step, e.g. 20→40 instead
  // of tracking the pointer to ~324). A single synthetic `input` event
  // (the OLD test above) can't see this class of bug — it only ever fires
  // once. This test fires a MULTI-STEP sequence (like a real drag) and
  // asserts (a) the slider element's reference never changes and stays
  // connected, and (b) the final color reflects the LAST step, not the
  // first — the two invariants a destroy-and-rebuild regression would break.
  it("a multi-step Hue drag keeps the same slider element and accumulates to the final value (regression: render() must never run mid-drag)", () => {
    inspector.setTarget(themeTarget("bold")!);
    const originalHueInput = host.querySelectorAll<HTMLInputElement>(".theme-inspector-slider-row input")[0]!;

    const dragSteps = [40, 90, 140, 190, 240, 290, 324]; // mimics 7 mousemove ticks of one drag gesture
    for (const v of dragSteps) {
      const liveHueInput = host.querySelectorAll<HTMLInputElement>(".theme-inspector-slider-row input")[0]!;
      expect(liveHueInput).toBe(originalHueInput); // never rebuilt mid-drag
      expect(liveHueInput.isConnected).toBe(true);
      liveHueInput.value = String(v);
      liveHueInput.dispatchEvent(new Event("input"));
    }

    const finalHex = themeJsonSetting.get().colors.bold!;
    const finalHue = hexToHsl(finalHex).h;
    // The drag's LAST step (324), not its first (40) or some frozen
    // mid-gesture value — allow slack for the hex round-trip's integer
    // rounding compounding over 7 steps (each step re-derives H/S/L from the
    // PREVIOUS step's stored hex, by design — see currentBaselineHex).
    expect(Math.abs(finalHue - 324)).toBeLessThan(6);
  });

  it("프리셋 기본값으로 restores presetDefaultFor's value", () => {
    inspector.setTarget(themeTarget("bold")!);
    const chip = host.querySelector<HTMLElement>('.theme-chip[aria-label="블루"]')!;
    chip.click();
    expect(themeJsonSetting.get().colors.bold).toBe("#1d6fb8");

    const resetBtn = Array.from(host.querySelectorAll<HTMLElement>(".theme-inspector-btn")).find(
      (b) => b.textContent === "프리셋 기본값으로",
    )!;
    resetBtn.click();
    expect(themeJsonSetting.get().colors.bold).toBe(presetDefaultFor(builtInTheme("light"), "bold"));
  });

  it("reflects an externally-applied theme (JSON import) while a target is selected", () => {
    inspector.setTarget(themeTarget("bold")!);
    const customTheme = { ...builtInTheme("light"), colors: { ...builtInTheme("light").colors, bold: "#123456" } };
    themeJsonSetting.set(customTheme);
    expect(host.querySelector(".theme-inspector-hex")!.textContent).toBe("#123456");
  });

  it("has no HEX <input type=text> anywhere (design decision 6: no typed hex input)", () => {
    inspector.setTarget(themeTarget("bold")!);
    (host.querySelectorAll<HTMLElement>(".theme-inspector-tab")[1]!).click();
    const textInputs = host.querySelectorAll('input[type="text"]');
    expect(textInputs.length).toBe(0);
  });
});
