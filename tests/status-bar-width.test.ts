import { describe, it, expect, beforeEach } from "vitest";
import { makeWidthSlider } from "../src/chrome/status-bar/width";
import {
  readingWidthSetting,
  READING_WIDTH_MIN_CH,
  READING_WIDTH_MAX_CH,
} from "../src/settings/app";

// The footer reading-width slider is a second view onto readingWidthSetting (the
// same SSOT as Settings › 본문 너비). These lock: (1) it reflects the setting on
// mount and on change from any writer, (2) dragging it writes back to the
// setting, (3) its bounds come from the shared clamp consts (no drift).

describe("makeWidthSlider (footer reading-width control)", () => {
  beforeEach(() => {
    localStorage.clear();
    readingWidthSetting.set(68); // known baseline
  });

  it("reflects the current setting value on mount", () => {
    readingWidthSetting.set(72);
    const { el } = makeWidthSlider();
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("72");
  });

  it("dragging (input event) writes the value back to the setting", () => {
    const { el } = makeWidthSlider();
    const input = el.querySelector("input") as HTMLInputElement;
    input.value = "80";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(readingWidthSetting.get()).toBe(80);
  });

  it("re-reflects when another writer changes the setting", () => {
    const { el } = makeWidthSlider();
    const input = el.querySelector("input") as HTMLInputElement;
    readingWidthSetting.set(50); // e.g. the Settings panel slider
    expect(input.value).toBe("50");
  });

  it("uses the shared SSOT bounds (no drift from the valid-measure rule)", () => {
    const { el } = makeWidthSlider();
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.min).toBe(String(READING_WIDTH_MIN_CH));
    expect(input.max).toBe(String(READING_WIDTH_MAX_CH));
  });

  it("carries an accessible name", () => {
    const { el } = makeWidthSlider();
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe("본문 너비");
  });
});
