import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RENDER } from "../src/settings/panel/controls";
import { themeJsonSetting } from "../src/settings/app";
import { builtInTheme } from "../src/settings/theme-schema";

describe("Theme Visual Editor", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  it("renders 8 swatches with correct Korean labels", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    const swatches = host.querySelectorAll(".theme-swatch-card");
    expect(swatches.length).toBe(8);

    const expectedLabels = [
      "배경색",
      "글자색",
      "카드 영역",
      "테두리색",
      "강조색",
      "링크색",
      "보조 글자",
      "형광펜 배경",
    ];

    swatches.forEach((swatch, idx) => {
      const labelText = swatch.querySelector(".theme-swatch-label")?.textContent;
      expect(labelText).toBe(expectedLabels[idx]);
    });
  });

  it("updates setting value when swatch color picker changes", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    const initialTheme = themeJsonSetting.get();

    // Trigger color change on "bg" color swatch picker (index 0)
    const bgInput = host.querySelector(".theme-swatch-input") as HTMLInputElement;
    expect(bgInput).toBeTruthy();

    bgInput.value = "#ff0000";
    bgInput.dispatchEvent(new Event("input"));

    const updatedTheme = themeJsonSetting.get();
    expect(updatedTheme.colors.bg).toBe("#ff0000");

    // Revert changes
    themeJsonSetting.set(initialTheme);
  });

  it("validates and applies theme when text JSON editing and click Apply", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    const initialTheme = themeJsonSetting.get();

    const textarea = host.querySelector(".settings-json") as HTMLTextAreaElement;
    const applyButton = host.querySelector('[data-act="apply"]') as HTMLButtonElement;
    const errorDiv = host.querySelector(".settings-json-error") as HTMLDivElement;

    // Paste invalid JSON
    textarea.value = "{ invalid json }";
    applyButton.click();

    expect(errorDiv.textContent).toBe("유효하지 않은 테마 JSON입니다.");
    expect(themeJsonSetting.get()).toEqual(initialTheme);

    // Paste valid JSON
    const customTheme = builtInTheme("light");
    customTheme.colors.bg = "#f0f0f0";
    textarea.value = JSON.stringify(customTheme);
    applyButton.click();

    expect(errorDiv.textContent).toBe("");
    expect(themeJsonSetting.get().colors.bg).toBe("#f0f0f0");

    // Revert changes
    themeJsonSetting.set(initialTheme);
  });
});
