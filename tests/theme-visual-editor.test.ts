import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RENDER, attachTeardown, runTeardown } from "../src/settings/panel/controls";
import { themeJsonSetting, syncJsonToPreset } from "../src/settings/app";
import { builtInTheme, parseTheme, serializeTheme } from "../src/settings/theme-schema";

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

  it("renders 18 cards across core + markdown columns", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    const cards = host.querySelectorAll(".theme-swatch-card");
    expect(cards.length).toBe(18);
  });

  it("labels the 18 cards with the spec Korean text", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    // Core column (9) then markdown column (9), in declared order.
    const expectedLabels = [
      "에디터 배경색",
      "기본 본문 글자색",
      "카드 영역 배경색",
      "테두리선 색상",
      "강조 요소 색상",
      "[[위키링크 (Link)]]",
      "보조 텍스트 (Muted)",
      "==형광펜 배경색 (Highlight Bg)==",
      "==형광펜 글자색 (Highlight Text)==",
      "# 제목 1 (H1)",
      "## 제목 2 (H2)",
      "### 제목 3 (H3)",
      "#### 제목 4 (H4)",
      "##### 제목 5 (H5)",
      "###### 제목 6 (H6)",
      "**굵은 글자 (Bold)**",
      "*기울임꼴 (Italic)*",
      "`인라인 코드 (Code)`",
    ];

    const cards = host.querySelectorAll(".theme-swatch-card");
    cards.forEach((card, idx) => {
      const labelText = card.querySelector(".theme-swatch-label")?.textContent;
      expect(labelText).toBe(expectedLabels[idx]);
    });
  });

  it("keeps 18 color inputs total but only 9 circular swatches (core column only)", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);
    // 2026-07-12 design-polish pass: the markdown column's circular swatches
    // were dropped (all 9 rendered as identical black-ink circles — zero
    // information, since the column already has a live text preview). The
    // color <input> stays for every card (still the click target); only the
    // circle is core-only now.
    expect(host.querySelectorAll(".theme-swatch-input").length).toBe(18);
    expect(host.querySelectorAll(".theme-swatch-color").length).toBe(9);
  });

  it("markdown (previewVar) cards carry is-preview and render no circular swatch", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);
    for (const key of ["h1", "h2", "h3", "h4", "h5", "h6", "bold", "italic", "code"]) {
      const preview = host.querySelector(`.theme-preview-${key}`)!;
      const card = preview.closest(".theme-swatch-card")!;
      expect(card.classList.contains("is-preview"), `${key} card missing is-preview`).toBe(true);
      expect(card.querySelector(".theme-swatch-color"), `${key} card still has a circle`).toBeNull();
      expect(card.querySelector(".theme-swatch-input"), `${key} card lost its color input`).not.toBeNull();
    }
  });

  it("core cards do NOT carry is-preview and keep their circular swatch", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);
    const coreKeys = ["bg", "fg", "surface", "border", "accent", "link", "muted", "highlightBg", "highlight"];
    const cards = host.querySelectorAll(".theme-swatch-card");
    for (let i = 0; i < coreKeys.length; i++) {
      expect(cards[i]!.classList.contains("is-preview")).toBe(false);
      expect(cards[i]!.querySelector(".theme-swatch-color")).not.toBeNull();
    }
  });

  it("binds markdown preview elements to their CSS color vars", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    // Each markdown card carries a preview element whose color resolves from the var.
    for (const key of ["h1", "h2", "h3", "h4", "h5", "h6", "bold", "italic", "code"]) {
      const preview = host.querySelector(`.theme-preview-${key}`) as HTMLElement | null;
      expect(preview, `preview for ${key} missing`).toBeTruthy();
      expect(preview!.style.color).toContain(`--${key}-color`);
    }
  });

  it("updates setting value when the first (bg) swatch picker changes", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    const initialTheme = themeJsonSetting.get();

    // First card is bg (core column leads).
    const bgInput = host.querySelector(".theme-swatch-input") as HTMLInputElement;
    expect(bgInput).toBeTruthy();

    bgInput.value = "#ff0000";
    bgInput.dispatchEvent(new Event("input"));

    expect(themeJsonSetting.get().colors.bg).toBe("#ff0000");

    themeJsonSetting.set(initialTheme);
  });

  it("updates an extended key (h1) when its picker changes", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    const initialTheme = themeJsonSetting.get();

    const h1Card = Array.from(host.querySelectorAll(".theme-swatch-card")).find(
      (c) => c.querySelector(".theme-swatch-label")?.textContent === "# 제목 1 (H1)",
    )!;
    const h1Input = h1Card.querySelector(".theme-swatch-input") as HTMLInputElement;
    h1Input.value = "#ff0000";
    h1Input.dispatchEvent(new Event("input"));

    expect(themeJsonSetting.get().colors.h1).toBe("#ff0000");

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

describe("parseTheme backward-compat", () => {
  // The serialized form of a pre-extension (8-key) theme: take a current preset
  // and strip every extended key, so it mirrors a value saved by an older build.
  function legacyEightKeyJson(preset: "dark" | "light"): string {
    const t = builtInTheme(preset);
    const eight = {
      bg: t.colors.bg,
      fg: t.colors.fg,
      accent: t.colors.accent,
      link: t.colors.link,
      surface: t.colors.surface,
      border: t.colors.border,
      muted: t.colors.muted,
      highlightBg: t.colors.highlightBg,
    };
    return JSON.stringify({ ...t, colors: eight });
  }

  it("parses an old 8-key theme without rejecting it (no reset)", () => {
    const parsed = parseTheme(legacyEightKeyJson("dark"));
    expect(parsed).not.toBeNull();
    // core 8 keys preserved verbatim
    expect(parsed!.colors.bg).toBe("#131110");
    expect(parsed!.colors.fg).toBe("#ffffff");
    expect(parsed!.colors.accent).toBe("#a8c8e8");
    expect(parsed!.colors.muted).toBe("#a8a29e");
  });

  it("promotes a legacy 8-key theme to the full 18-key set via fallback", () => {
    const parsed = parseTheme(legacyEightKeyJson("dark"))!;
    // h1~h5, bold, italic fall back to fg
    expect(parsed.colors.h1).toBe(parsed.colors.fg);
    expect(parsed.colors.h2).toBe(parsed.colors.fg);
    expect(parsed.colors.h3).toBe(parsed.colors.fg);
    expect(parsed.colors.h4).toBe(parsed.colors.fg);
    expect(parsed.colors.h5).toBe(parsed.colors.fg);
    expect(parsed.colors.bold).toBe(parsed.colors.fg);
    expect(parsed.colors.italic).toBe(parsed.colors.fg);
    // h6 → muted
    expect(parsed.colors.h6).toBe(parsed.colors.muted);
    // code → accent
    expect(parsed.colors.code).toBe(parsed.colors.accent);
    // highlight → fixed ink literal
    expect(parsed.colors.highlight).toBe("#1a1300");
  });

  it("keeps an explicit extended key and fills the rest from fallback", () => {
    const t = builtInTheme("dark");
    const json = JSON.stringify({
      ...t,
      colors: { ...t.colors, h1: "#ff0000" },
    });
    const parsed = parseTheme(json)!;
    expect(parsed.colors.h1).toBe("#ff0000"); // explicit value wins
    expect(parsed.colors.h2).toBe(parsed.colors.fg); // others fall back
  });

  it("treats a corrupt extended key as absent (fallback) without rejecting the theme", () => {
    const t = builtInTheme("dark");
    const json = JSON.stringify({
      ...t,
      colors: { ...t.colors, code: "" }, // empty string = damaged partial key
    });
    const parsed = parseTheme(json);
    expect(parsed).not.toBeNull(); // whole theme NOT rejected
    expect(parsed!.colors.code).toBe(parsed!.colors.accent); // code falls back to accent
  });

  it("still strict-rejects a missing CORE key (SSOT integrity)", () => {
    const t = builtInTheme("dark");
    const broken = { ...t.colors } as Record<string, unknown>;
    delete broken.bg; // core key missing
    const json = JSON.stringify({ ...t, colors: broken });
    expect(parseTheme(json)).toBeNull();
  });

  it("round-trips an 18-key theme through serialize → parse", () => {
    const built = builtInTheme("light");
    const reparsed = parseTheme(serializeTheme(built))!;
    expect(reparsed.colors.h1).toBe(built.colors.h1);
    expect(reparsed.colors.code).toBe(built.colors.code);
    expect(reparsed.colors.highlight).toBe(built.colors.highlight);
  });
});

describe("builtInTheme extended values match the fallback rule (zero drift)", () => {
  it("dark preset extended colors equal what promotion would derive", () => {
    const dark = builtInTheme("dark");
    expect(dark.colors.h1).toBe(dark.colors.fg);
    expect(dark.colors.h6).toBe(dark.colors.muted);
    expect(dark.colors.bold).toBe(dark.colors.fg);
    expect(dark.colors.italic).toBe(dark.colors.fg);
    expect(dark.colors.code).toBe(dark.colors.accent);
    expect(dark.colors.highlight).toBe("#1a1300");
  });

  it("light preset extended colors equal what promotion would derive", () => {
    const light = builtInTheme("light");
    expect(light.colors.h1).toBe(light.colors.fg);
    expect(light.colors.h6).toBe(light.colors.muted);
    expect(light.colors.code).toBe(light.colors.accent);
    expect(light.colors.highlight).toBe("#1a1300");
  });
});

describe("preset sync", () => {
  beforeEach(() => {
    localStorage.clear();
    themeJsonSetting.set(builtInTheme("dark"));
  });
  afterEach(() => {
    themeJsonSetting.set(builtInTheme("dark"));
  });

  it("overwrites themeJson with the preset builtin when the name differs", () => {
    themeJsonSetting.set(builtInTheme("dark"));
    syncJsonToPreset("light");
    expect(themeJsonSetting.get().name).toBe("light");
    expect(themeJsonSetting.get().colors.bg).toBe(builtInTheme("light").colors.bg);
  });

  it("is a no-op when the name already matches (loop guard)", () => {
    themeJsonSetting.set(builtInTheme("light"));
    const spy = vi.fn();
    const unsub = themeJsonSetting.subscribe(spy);
    syncJsonToPreset("light"); // names already match
    expect(spy).not.toHaveBeenCalled(); // no set → no notification
    unsub();
  });

  it("preserves user edits when re-selecting the same preset name", () => {
    const edited = { ...builtInTheme("dark"), colors: { ...builtInTheme("dark").colors, h1: "#abcdef" } };
    themeJsonSetting.set(edited);
    syncJsonToPreset("dark"); // same name → must not clobber the edit
    expect(themeJsonSetting.get().colors.h1).toBe("#abcdef");
  });
});

describe("subscription teardown", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    themeJsonSetting.set(builtInTheme("dark"));
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
    themeJsonSetting.set(builtInTheme("dark"));
  });

  it("stops reflecting into a torn-down control's inputs", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    const bgInput = host.querySelector(".theme-swatch-input") as HTMLInputElement;
    // External change reflects while live.
    themeJsonSetting.set({ ...builtInTheme("dark"), colors: { ...builtInTheme("dark").colors, bg: "#111111" } });
    expect(bgInput.value).toBe("#111111");

    // After teardown, further external changes must NOT update the stale DOM.
    runTeardown(el);
    themeJsonSetting.set({ ...builtInTheme("dark"), colors: { ...builtInTheme("dark").colors, bg: "#222222" } });
    expect(bgInput.value).toBe("#111111"); // unchanged → no stale reflect
  });

  it("attachTeardown / runTeardown round-trip runs every registered fn once", () => {
    const el = document.createElement("div");
    const a = vi.fn();
    const b = vi.fn();
    attachTeardown(el, [a, b]);
    runTeardown(el);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    // Idempotent: a second run does not re-fire (subscriptions already cleared).
    runTeardown(el);
    expect(a).toHaveBeenCalledTimes(1);
  });
});
