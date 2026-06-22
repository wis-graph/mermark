import { describe, it, expect, beforeEach, vi } from "vitest";

describe("app settings", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    // systemTheme() reads matchMedia; matches:false → "dark"
    vi.stubGlobal("matchMedia", () => ({ matches: false }) as unknown as MediaQueryList);
  });

  it("themeSetting defaults to the system theme and persists under mermark.theme", async () => {
    const { themeSetting } = await import("../src/settings/app");
    expect(themeSetting.get()).toBe("dark");
    themeSetting.set("light");
    expect(localStorage.getItem("mermark.theme")).toBe("light");
  });

  it("themeSetting reads a saved preference over the system theme", async () => {
    localStorage.setItem("mermark.theme", "light");
    const { themeSetting } = await import("../src/settings/app");
    expect(themeSetting.get()).toBe("light");
  });

  it("modeSetting defaults to read and persists under mermark.mode", async () => {
    const { modeSetting } = await import("../src/settings/app");
    expect(modeSetting.get()).toBe("read");
    modeSetting.set("edit");
    expect(localStorage.getItem("mermark.mode")).toBe("edit");
  });

  it("modeSetting reads a saved edit preference", async () => {
    localStorage.setItem("mermark.mode", "edit");
    const { modeSetting } = await import("../src/settings/app");
    expect(modeSetting.get()).toBe("edit");
  });

  it("fontScaleSetting defaults to 1.0 and persists under mermark.fontScale", async () => {
    const { fontScaleSetting } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(1.0);
    fontScaleSetting.set(1.2);
    expect(localStorage.getItem("mermark.fontScale")).toBe("1.2");
  });

  it("fontScaleSetting reads a saved scale over the default", async () => {
    localStorage.setItem("mermark.fontScale", "1.5");
    const { fontScaleSetting } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(1.5);
  });

  it("fontScaleSetting clamps an out-of-range saved scale to the bounds", async () => {
    localStorage.setItem("mermark.fontScale", "5");
    const { fontScaleSetting } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(2.0); // MAX
  });

  it("fontScaleSetting clamps a below-min saved scale up to the floor", async () => {
    localStorage.setItem("mermark.fontScale", "0.1");
    const { fontScaleSetting } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(0.8); // MIN
  });

  it("fontScaleSetting falls back to the default on a corrupt saved scale", async () => {
    localStorage.setItem("mermark.fontScale", "abc");
    const { fontScaleSetting } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(1.0); // NaN → default
  });

  it("clampFontScale snaps to the bounds and the 0.1 step", async () => {
    const { clampFontScale } = await import("../src/settings/app");
    expect(clampFontScale(2.5)).toBe(2.0); // above MAX
    expect(clampFontScale(0.5)).toBe(0.8); // below MIN
    expect(clampFontScale(1.04)).toBe(1.0); // snaps down to step
    expect(clampFontScale(1.06)).toBe(1.1); // snaps up to step
  });

  it("zoomIn / zoomOut / resetZoom move the setting by the clamped step and persist", async () => {
    const { fontScaleSetting, zoomIn, zoomOut, resetZoom } = await import("../src/settings/app");
    expect(fontScaleSetting.get()).toBe(1.0);

    zoomIn();
    expect(fontScaleSetting.get()).toBe(1.1);
    expect(localStorage.getItem("mermark.fontScale")).toBe("1.1"); // SSOT writer persists

    // clamp at MAX: spamming zoomIn stops at 2.0
    for (let i = 0; i < 20; i++) zoomIn();
    expect(fontScaleSetting.get()).toBe(2.0);

    resetZoom();
    expect(fontScaleSetting.get()).toBe(1.0);

    zoomOut();
    expect(fontScaleSetting.get()).toBe(0.9);

    // clamp at MIN: spamming zoomOut stops at 0.8
    for (let i = 0; i < 20; i++) zoomOut();
    expect(fontScaleSetting.get()).toBe(0.8);
  });

  it("applyFontScale writes the scale to the --font-scale CSS var", async () => {
    const { applyFontScale } = await import("../src/theme");
    applyFontScale(1.4);
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.4");
  });

  it("themeJsonSetting defaults to the system preset and persists under mermark.themeJson", async () => {
    const { themeJsonSetting } = await import("../src/settings/app");
    const { builtInTheme } = await import("../src/settings/theme-schema");
    // matchMedia matches:false → systemTheme() = "dark"
    expect(themeJsonSetting.get()).toEqual(builtInTheme("dark"));
    const light = builtInTheme("light");
    themeJsonSetting.set(light);
    expect(localStorage.getItem("mermark.themeJson")).toBe(JSON.stringify(light, null, 2));
  });

  it("themeJsonSetting parses a saved JSON theme on construction", async () => {
    const { builtInTheme, serializeTheme } = await import("../src/settings/theme-schema");
    localStorage.setItem("mermark.themeJson", serializeTheme(builtInTheme("light")));
    const { themeJsonSetting } = await import("../src/settings/app");
    expect(themeJsonSetting.get()).toEqual(builtInTheme("light"));
  });

  it("themeJsonSetting falls back to the default on a corrupt saved JSON", async () => {
    localStorage.setItem("mermark.themeJson", "{ broken");
    const { themeJsonSetting } = await import("../src/settings/app");
    const { builtInTheme } = await import("../src/settings/theme-schema");
    expect(themeJsonSetting.get()).toEqual(builtInTheme("dark")); // parse → null → default
  });

  it("loadPreset writes BOTH themeJsonSetting and themeSetting (coherence in one place)", async () => {
    const { themeSetting, themeJsonSetting, loadPreset } = await import("../src/settings/app");
    const { builtInTheme } = await import("../src/settings/theme-schema");
    loadPreset("light");
    expect(themeSetting.get()).toBe("light");
    expect(themeJsonSetting.get()).toEqual(builtInTheme("light"));
  });

  it("themeSetting still defaults/persists after migration to the registry", async () => {
    const { themeSetting } = await import("../src/settings/app");
    expect(themeSetting.get()).toBe("dark"); // unchanged from pre-migration
    themeSetting.set("light");
    expect(localStorage.getItem("mermark.theme")).toBe("light");
  });

  it("themeSetting appears in the registry under the 테마 group", async () => {
    await import("../src/settings/app");
    const { groups } = await import("../src/settings/registry");
    const theme = groups().find((g) => g.name === "테마");
    expect(theme).toBeDefined();
    expect(theme!.entries.some((e) => e.ui.label === "테마 JSON")).toBe(true);
  });

  it("declares the typography settings with defaults and persistence", async () => {
    const app = await import("../src/settings/app");
    expect(app.fontSizeSetting.get()).toBe(16); // 1rem base
    expect(app.lineHeightSetting.get()).toBe(1.6);
    expect(app.readingWidthSetting.get()).toBe(68); // P2: measure is ch-based now
    app.fontSizeSetting.set(18);
    expect(localStorage.getItem("mermark.fontSize")).toBe("18");
  });

  it("clampReadingWidth holds the 40–90ch measure rule", async () => {
    const { clampReadingWidth } = await import("../src/settings/app");
    expect(clampReadingWidth(820)).toBe(90); // px-era saved value → clamp-as-migration ceiling
    expect(clampReadingWidth(30)).toBe(40); // below the floor
    expect(clampReadingWidth(68)).toBe(68); // inside the range passes through
  });

  it("readingWidthSetting clamps a px-era saved value to the ch ceiling (clamp-as-migration)", async () => {
    localStorage.setItem("mermark.readingWidth", "820"); // a value stored in the px era
    const { readingWidthSetting } = await import("../src/settings/app");
    expect(readingWidthSetting.get()).toBe(90); // parse routes through clampReadingWidth → 90ch
  });

  it("readingWidthSetting reads an in-range saved ch value over the default", async () => {
    localStorage.setItem("mermark.readingWidth", "72");
    const { readingWidthSetting } = await import("../src/settings/app");
    expect(readingWidthSetting.get()).toBe(72);
  });

  it("readingWidthSetting falls back to the default on a corrupt saved value", async () => {
    localStorage.setItem("mermark.readingWidth", "abc");
    const { readingWidthSetting } = await import("../src/settings/app");
    expect(readingWidthSetting.get()).toBe(68); // NaN → default
  });

  it("declares editor + mermaid settings with defaults", async () => {
    const app = await import("../src/settings/app");
    expect(app.defaultModeSetting.get()).toBe("read");
    expect(app.conflictPolicySetting.get()).toBe("pause");
    expect(app.panZoomSetting.get()).toBe("on");
    expect(app.themeForceSetting.get()).toBe("follow");
  });

  it("seedSessionMode seeds the live mode from the boot default (defaultMode=edit → mode=edit)", async () => {
    localStorage.setItem("mermark.defaultMode", "edit");
    const { modeSetting, defaultModeSetting, seedSessionMode } = await import("../src/settings/app");
    expect(defaultModeSetting.get()).toBe("edit");
    expect(modeSetting.get()).toBe("read"); // unseeded default
    seedSessionMode();
    expect(modeSetting.get()).toBe("edit"); // boot mode = the panel default
  });

  it("seedSessionMode leaves modeSetting as the live session value after boot (toggle ≠ default)", async () => {
    localStorage.setItem("mermark.defaultMode", "read");
    const { modeSetting, defaultModeSetting, seedSessionMode } = await import("../src/settings/app");
    seedSessionMode();
    expect(modeSetting.get()).toBe("read");
    modeSetting.set("edit"); // session ⌘E toggle
    expect(modeSetting.get()).toBe("edit");
    expect(defaultModeSetting.get()).toBe("read"); // boot source untouched by the toggle
  });

  it("renders all five categories in the registry (Theme/Typography/Editor/Mermaid/Plugins)", async () => {
    await import("../src/settings/app");
    const { groups } = await import("../src/settings/registry");
    const names = groups().map((g) => g.name);
    expect(names).toEqual(["테마", "타이포그래피", "에디터", "Mermaid", "플러그인"]);
  });

  // ── P0: Pretendard bundle — default-value regression guard ──────────────────

  const INTER_STACK = '"Inter", system-ui, sans-serif';

  it("fontFamilySetting still defaults to Inter after adding the Pretendard option (visual regression guard)", async () => {
    const { fontFamilySetting } = await import("../src/settings/app");
    // Adding "Pretendard" to FONT_STACKS must NOT flip the default — a user with no
    // saved preference keeps the current Inter visuals. Pretendard is opt-in only.
    expect(fontFamilySetting.get()).toBe(INTER_STACK);
  });

  it("FONT_STACKS exposes a Pretendard option in the 글꼴 select", async () => {
    await import("../src/settings/app");
    const { groups } = await import("../src/settings/registry");
    const typo = groups().find((g) => g.name === "타이포그래피");
    const font = typo!.entries.find((e) => e.ui.label === "글꼴");
    const control = font!.ui.control as { kind: "select"; options: { value: string; label: string }[] };
    expect(control.kind).toBe("select");
    expect(control.options.some((o) => /Pretendard/.test(String(o.value)))).toBe(true);
  });

  // ── P0: Google Fonts loader — googleFontHref (sanitization) ─────────────────

  describe("googleFontHref (Google Fonts URL builder + sanitization)", () => {
    it("builds a CSS2 stylesheet URL for a normal family with %20-encoded spaces", async () => {
      const { googleFontHref } = await import("../src/settings/app");
      expect(googleFontHref("Noto Sans KR")).toBe(
        "https://fonts.googleapis.com/css2?family=Noto%20Sans%20KR&display=swap",
      );
    });

    it("returns null for empty/whitespace input (off)", async () => {
      const { googleFontHref } = await import("../src/settings/app");
      expect(googleFontHref("")).toBeNull();
      expect(googleFontHref("   ")).toBeNull();
    });

    it("rejects every injection vector (null), so no second query param / CRLF / origin can be grafted on", async () => {
      const { googleFontHref } = await import("../src/settings/app");
      expect(googleFontHref("Roboto&import=x")).toBeNull(); // extra query param
      expect(googleFontHref('Roboto" onload="')).toBeNull(); // quote/attr break
      expect(googleFontHref("Roboto\r\nLocation: http://evil")).toBeNull(); // CRLF split
      expect(googleFontHref("../../evil")).toBeNull(); // path traversal
      expect(googleFontHref("Roboto?key=x")).toBeNull(); // '?'
      expect(googleFontHref("<script>")).toBeNull(); // angle brackets
      expect(googleFontHref("Roboto:wght@700")).toBeNull(); // colon (axis spec out of scope)
    });

    it("hardcodes the origin so a non-null result always starts with the Google Fonts host", async () => {
      const { googleFontHref } = await import("../src/settings/app");
      const href = googleFontHref("Lato");
      expect(href).not.toBeNull();
      expect(href!.startsWith("https://fonts.googleapis.com/")).toBe(true);
    });
  });

  // ── P0: Google Fonts loader — effectiveReadingFont (precedence) ─────────────

  describe("effectiveReadingFont (web-font vs select precedence)", () => {
    it("falls back to the select stack when the web font is empty", async () => {
      const { effectiveReadingFont } = await import("../src/settings/app");
      expect(effectiveReadingFont("", INTER_STACK)).toEqual({ family: "", stack: INTER_STACK });
    });

    it("prepends a non-empty web font and keeps the select stack as fallback", async () => {
      const { effectiveReadingFont } = await import("../src/settings/app");
      expect(effectiveReadingFont("Noto Sans KR", INTER_STACK)).toEqual({
        family: "Noto Sans KR",
        stack: `"Noto Sans KR", ${INTER_STACK}`,
      });
    });

    it("trims a whitespace-only web font to empty (no web font)", async () => {
      const { effectiveReadingFont } = await import("../src/settings/app");
      expect(effectiveReadingFont("   ", INTER_STACK)).toEqual({ family: "", stack: INTER_STACK });
    });
  });

  // ── P0: Google Fonts loader — webFontSetting declaration ────────────────────

  describe("webFontSetting", () => {
    it("defaults to an empty string (no web font = prior behavior)", async () => {
      const { webFontSetting } = await import("../src/settings/app");
      expect(webFontSetting.get()).toBe("");
    });

    it("persists a typed family under mermark.webFont", async () => {
      const { webFontSetting } = await import("../src/settings/app");
      webFontSetting.set("Roboto");
      expect(localStorage.getItem("mermark.webFont")).toBe("Roboto");
    });

    it("reads a saved family on construction", async () => {
      localStorage.setItem("mermark.webFont", "Lato");
      const { webFontSetting } = await import("../src/settings/app");
      expect(webFontSetting.get()).toBe("Lato");
    });

    it("appears in the 타이포그래피 group as a text control", async () => {
      await import("../src/settings/app");
      const { groups } = await import("../src/settings/registry");
      const typo = groups().find((g) => g.name === "타이포그래피");
      const entry = typo!.entries.find((e) => e.ui.label === "웹폰트 (Google Fonts)");
      expect(entry).toBeDefined();
      expect(entry!.ui.control.kind).toBe("text");
    });
  });
});
