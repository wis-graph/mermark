import { describe, it, expect } from "vitest";
import {
  absentKind,
  builtInTheme,
  isOptionalKey,
  isSingleToken,
  parseTheme,
  promoteToExtended,
  resolveGeometry,
  resolveOptional,
  serializeTheme,
  themeToVars,
  upgradePristinePreset,
  type Theme,
} from "../src/settings/theme-schema";
import { contrastRatio } from "../src/settings/panel/color-math";

// An 8-core-key theme (a pre-extension value). parseTheme promotes it to the full
// 18-key set, so assertions about parse output compare against `promotedTheme`.
const validTheme: Theme = {
  name: "test",
  colors: {
    bg: "#111111",
    fg: "#eeeeee",
    accent: "#abcdef",
    link: "#123456",
    surface: "#222222",
    border: "#333333",
    muted: "#999999",
    highlightBg: "#ffff00",
  },
  radii: { md: "8px", lg: "12px", xl: "16px" },
  font: { sans: "Inter, sans-serif" },
};

// The same theme after the extended-key promotion rule fills h1~h6/bold/italic/
// code/highlight from the core palette — what parseTheme returns for an old theme.
const promotedTheme: Theme = {
  ...validTheme,
  colors: { ...validTheme.colors, ...promoteToExtended(validTheme.colors) },
};

describe("parseTheme", () => {
  it("accepts a valid 8-key theme JSON string and returns a promoted (18-key) Theme", () => {
    const parsed = parseTheme(JSON.stringify(validTheme));
    expect(parsed).toEqual(promotedTheme); // core preserved, extended filled by fallback
  });

  it("preserves an explicit comment value instead of falling back to muted", () => {
    const withComment = { ...validTheme, colors: { ...validTheme.colors, comment: "#654321" } };
    const parsed = parseTheme(JSON.stringify(withComment));
    expect(parsed?.colors.comment).toBe("#654321");
  });

  it("returns null for invalid JSON", () => {
    expect(parseTheme("{ not json")).toBeNull();
  });

  it("returns null for null input (nothing stored → default fallback)", () => {
    expect(parseTheme(null)).toBeNull();
  });

  it("returns null when a color field is missing", () => {
    const broken = { ...validTheme, colors: { ...validTheme.colors } } as { colors: Record<string, string> };
    delete broken.colors.accent;
    expect(parseTheme(JSON.stringify(broken))).toBeNull();
  });

  it("returns null when a color is an empty string", () => {
    const broken = { ...validTheme, colors: { ...validTheme.colors, bg: "" } };
    expect(parseTheme(JSON.stringify(broken))).toBeNull();
  });

  it("returns null when a color is not a string", () => {
    const broken = { ...validTheme, colors: { ...validTheme.colors, fg: 123 } };
    expect(parseTheme(JSON.stringify(broken))).toBeNull();
  });

  it("returns null when radii are missing", () => {
    const broken = { ...validTheme } as Partial<Theme>;
    delete broken.radii;
    expect(parseTheme(JSON.stringify(broken))).toBeNull();
  });

  it("returns null when font.sans is missing", () => {
    const broken = { ...validTheme, font: {} as { sans: string } };
    expect(parseTheme(JSON.stringify(broken))).toBeNull();
  });
});

describe("serializeTheme ∘ parseTheme round-trip", () => {
  it("round-trips an 8-key theme through serialize → parse (promoted to 18)", () => {
    const text = serializeTheme(validTheme);
    expect(parseTheme(text)).toEqual(promotedTheme); // re-parse fills extended keys
  });

  it("round-trips a fully-promoted theme unchanged", () => {
    const text = serializeTheme(promotedTheme);
    expect(parseTheme(text)).toEqual(promotedTheme); // already 18-key → stable
  });

  it("serializes as 2-space pretty JSON (human-editable textarea)", () => {
    const text = serializeTheme(validTheme);
    expect(text).toContain('\n  "name"'); // 2-space indent
    expect(JSON.parse(text)).toEqual(validTheme);
  });

  it("round-trips the built-in themes byte-for-byte", () => {
    for (const name of ["dark", "light", "claude"] as const) {
      const t = builtInTheme(name);
      expect(parseTheme(serializeTheme(t))).toEqual(t);
    }
  });
});

describe("themeToVars maps every field to the right CSS var", () => {
  it("produces all vars: 8 core + 11 extended (incl. comment) + 11 background + 4 misc", () => {
    const vars = themeToVars(validTheme); // 8-key input → extended/background vars come from fallback
    expect(vars).toEqual({
      "--bg": "#111111",
      "--fg": "#eeeeee",
      "--accent": "#abcdef",
      "--link": "#123456",
      "--surface": "#222222",
      "--border": "#333333",
      "--muted": "#999999",
      "--highlight-bg": "#ffff00",
      // extended: h1~h5/bold/italic → fg, h6 → muted, code → accent, highlight ink,
      // comment → muted (comment's own fallback, same "quiet aside" role as muted).
      "--h1-color": "#eeeeee",
      "--h2-color": "#eeeeee",
      "--h3-color": "#eeeeee",
      "--h4-color": "#eeeeee",
      "--h5-color": "#eeeeee",
      "--h6-color": "#999999",
      "--bold-color": "#eeeeee",
      "--italic-color": "#eeeeee",
      "--code-color": "#abcdef",
      "--highlight-color": "#1a1300",
      "--comment-color": "#999999",
      // background: every key absent on validTheme → intrinsic default. codeBg
      // alone resolves to the surface-veil chip fill; the rest are transparent.
      "--bold-bg": "transparent",
      "--italic-bg": "transparent",
      "--code-bg": "var(--surface-veil)",
      "--link-bg": "transparent",
      "--comment-bg": "transparent",
      "--h1-bg": "transparent",
      "--h2-bg": "transparent",
      "--h3-bg": "transparent",
      "--h4-bg": "transparent",
      "--h5-bg": "transparent",
      "--h6-bg": "transparent",
      // round 2 (2026-08): 9 new vars, always emitted. "initial" for every key
      // except --strike-bg (→ "transparent") — see OPTIONAL_INTRINSIC.
      "--bold-italic-color": "initial",
      "--bold-italic-bg": "initial",
      "--strike-color": "initial",
      "--strike-bg": "transparent",
      "--quote-color": "initial",
      "--quote-bg": "initial",
      "--quote-bar": "initial",
      "--codeblock-color": "initial",
      "--codeblock-bg": "initial",
      // round 3: highlightBlockBg, same always-emit "auto" rule.
      "--highlightblock-bg": "initial",
      "--radius-md": "8px",
      "--radius-lg": "12px",
      "--radius-xl": "16px",
      "--font-sans": "Inter, sans-serif",
      // round 3: block geometry, always emitted, absent → "initial".
      "--block-radius": "initial",
      "--block-padding": "initial",
    });
  });

  it("emits an explicit extended color verbatim instead of the fallback", () => {
    const vars = themeToVars({
      ...validTheme,
      colors: { ...validTheme.colors, h1: "#ff0000" },
    });
    expect(vars["--h1-color"]).toBe("#ff0000"); // explicit wins
    expect(vars["--h2-color"]).toBe("#eeeeee"); // others still fall back to fg
  });

  it("emits an explicit background color verbatim when set", () => {
    const vars = themeToVars({
      ...validTheme,
      colors: { ...validTheme.colors, boldBg: "#ff00ff" },
    });
    expect(vars["--bold-bg"]).toBe("#ff00ff");
    expect(vars["--italic-bg"]).toBe("transparent"); // untouched keys stay intrinsic
  });

  it("always emits all 20 optional vars, never conditionally (stale-var guard)", () => {
    const withNone = themeToVars(validTheme);
    const withOne = themeToVars({ ...validTheme, colors: { ...validTheme.colors, h1Bg: "#123" } });
    // Every optional key present in BOTH outputs — switching themes can never
    // leave a var missing from the map (themeVarsSink only overwrites).
    for (const key of ["--bold-bg", "--italic-bg", "--code-bg", "--link-bg", "--comment-bg",
      "--h1-bg", "--h2-bg", "--h3-bg", "--h4-bg", "--h5-bg", "--h6-bg",
      "--bold-italic-color", "--bold-italic-bg", "--strike-color", "--strike-bg",
      "--quote-color", "--quote-bg", "--quote-bar", "--codeblock-color", "--codeblock-bg"]) {
      expect(withNone).toHaveProperty(key);
      expect(withOne).toHaveProperty(key);
    }
    expect(withOne["--h1-bg"]).toBe("#123");
  });

  it("emits an explicit round-2 value verbatim (quoteBg) instead of the 'auto' intrinsic", () => {
    const vars = themeToVars({ ...validTheme, colors: { ...validTheme.colors, quoteBg: "#ff00ff" } });
    expect(vars["--quote-bg"]).toBe("#ff00ff");
    expect(vars["--quote-bar"]).toBe("initial"); // untouched optional keys stay intrinsic
  });

  it("does not introduce --radius-sm (styles.css never defines it)", () => {
    expect(themeToVars(validTheme)).not.toHaveProperty("--radius-sm");
  });
});

describe("resolveOptional: 부재한 옵셔널 키가 무엇으로 방출되는가 (renamed from resolveBackground)", () => {
  it("codeBg resolves to the surface-veil chip fill when unset (zero-drift for the existing inline-code chip)", () => {
    expect(resolveOptional("codeBg", undefined)).toBe("var(--surface-veil)");
  });

  it("every round-1 background key except codeBg resolves to transparent when unset", () => {
    for (const key of ["boldBg", "italicBg", "linkBg", "commentBg", "h1Bg", "h2Bg", "h3Bg", "h4Bg", "h5Bg", "h6Bg"] as const) {
      expect(resolveOptional(key, undefined)).toBe("transparent");
    }
  });

  it("round-2 keys resolve to 'initial' when unset, except strikeBg (→ transparent)", () => {
    for (const key of ["boldItalic", "boldItalicBg", "strike", "quote", "quoteBg", "quoteBar", "codeBlock", "codeBlockBg"] as const) {
      expect(resolveOptional(key, undefined)).toBe("initial");
    }
    expect(resolveOptional("strikeBg", undefined)).toBe("transparent");
  });

  it("an explicit value always wins over the intrinsic default", () => {
    expect(resolveOptional("codeBg", "#abcdef")).toBe("#abcdef");
    expect(resolveOptional("boldBg", "#abcdef")).toBe("#abcdef");
    expect(resolveOptional("quoteBg", "#abcdef")).toBe("#abcdef");
  });
});

describe("absentKind: 키 부재가 '없음'인가 '자동'인가", () => {
  it("round-1 background keys are all 'none' (transparent = genuinely absent)", () => {
    for (const key of ["boldBg", "italicBg", "linkBg", "commentBg", "h1Bg", "h2Bg", "h3Bg", "h4Bg", "h5Bg", "h6Bg", "strikeBg"] as const) {
      expect(absentKind(key)).toBe("none");
    }
  });

  it("codeBg is 'auto' (label correction: it visibly shows the surface-veil chip fill, not truly absent)", () => {
    expect(absentKind("codeBg")).toBe("auto");
  });

  it("round-2 derived/inherited keys are all 'auto'", () => {
    for (const key of ["boldItalic", "boldItalicBg", "strike", "quote", "quoteBg", "quoteBar", "codeBlock", "codeBlockBg"] as const) {
      expect(absentKind(key)).toBe("auto");
    }
  });
});

describe("isOptionalKey: replaces the hand-maintained bgOptional flag", () => {
  it("every OPTIONAL_KEYS entry is optional", () => {
    const OPTIONAL_KEYS_FOR_TEST = [
      "boldBg", "italicBg", "codeBg", "linkBg", "commentBg",
      "h1Bg", "h2Bg", "h3Bg", "h4Bg", "h5Bg", "h6Bg",
      "boldItalic", "boldItalicBg", "strike", "strikeBg",
      "quote", "quoteBg", "quoteBar", "codeBlock", "codeBlockBg",
    ] as const;
    for (const key of OPTIONAL_KEYS_FOR_TEST) expect(isOptionalKey(key)).toBe(true);
  });

  it("a core (strict-required) key is NOT optional — e.g. highlightBg", () => {
    expect(isOptionalKey("highlightBg")).toBe(false);
  });

  it("an always-filled extended key is NOT optional — e.g. bold, comment", () => {
    expect(isOptionalKey("bold")).toBe(false);
    expect(isOptionalKey("comment")).toBe(false);
  });

  it("an unknown string is not optional", () => {
    expect(isOptionalKey("notARealKey")).toBe(false);
  });
});

describe("builtInTheme equals the current styles.css values (zero-drift)", () => {
  it("dark matches styles.css:4-16 (core) + the promotion rule (extended)", () => {
    const dark = builtInTheme("dark");
    expect(dark.colors).toEqual({
      bg: "#131110",
      fg: "#ffffff",
      accent: "#a8c8e8",
      link: "#a8c8e8",
      surface: "#1c1917",
      border: "rgba(255,255,255,.12)",
      muted: "#a8a29e",
      highlightBg: "#ffe066",
      // extended = exactly what promoteToExtended derives (zero drift)
      h1: "#ffffff",
      h2: "#ffffff",
      h3: "#ffffff",
      h4: "#ffffff",
      h5: "#ffffff",
      h6: "#a8a29e",
      bold: "#ffffff",
      italic: "#ffffff",
      code: "#a8c8e8",
      highlight: "#1a1300",
      comment: "#6b665f",
    });
    expect(dark.radii).toEqual({ md: "8px", lg: "12px", xl: "16px" });
    expect(dark.font).toEqual({ sans: '"Inter", system-ui, sans-serif' });
  });

  it("dark's explicit extended values (except comment) match the fallback rule applied to its core", () => {
    const dark = builtInTheme("dark");
    const derived = promoteToExtended(dark.colors);
    // comment is deliberately NOT what the fallback would derive (it would land on
    // --muted, the exact "구분 안 됨" complaint this key exists to fix — see 결정 5),
    // so it's checked separately below and excluded from this loop.
    for (const key of ["h1", "h2", "h3", "h4", "h5", "h6", "bold", "italic", "code", "highlight"] as const) {
      expect(dark.colors[key]).toBe(derived[key]);
    }
    expect(dark.colors.comment).not.toBe(derived.comment);
  });

  it("light matches styles.css:19-27 (core) + the promotion rule (extended)", () => {
    const light = builtInTheme("light");
    expect(light.colors).toEqual({
      bg: "#f5f5f5",
      fg: "#0c0a09",
      accent: "#292524",
      link: "#1d6fb8",
      surface: "#ffffff",
      border: "#e7e5e4",
      muted: "#777169",
      highlightBg: "#fff3a3",
      h1: "#0c0a09",
      h2: "#0c0a09",
      h3: "#0c0a09",
      h4: "#0c0a09",
      h5: "#0c0a09",
      h6: "#777169",
      bold: "#0c0a09",
      italic: "#0c0a09",
      code: "#292524",
      highlight: "#1a1300",
      comment: "#8f887e",
    });
  });

  it("light inherits dark's radii/font (styles.css light block does not re-declare them)", () => {
    const dark = builtInTheme("dark");
    const light = builtInTheme("light");
    expect(light.radii).toEqual(dark.radii);
    expect(light.font).toEqual(dark.font);
  });

  it("claude matches styles.css :root[data-theme=claude] (the editorial cream/coral palette)", () => {
    const claude = builtInTheme("claude");
    expect(claude.colors).toEqual({
      bg: "#faf9f5",
      fg: "#141413",
      accent: "#cc785c",
      link: "#a9583e",
      surface: "#efe9de",
      border: "#e6dfd8",
      muted: "#6c6a64",
      highlightBg: "#f0d9a8",
      // extended: headings ink (coral scarce), code coral-active, hand-tuned
      // body-strong/body/highlight — NOT all the promoteToExtended fallback.
      h1: "#141413",
      h2: "#141413",
      h3: "#141413",
      h4: "#141413",
      h5: "#141413",
      h6: "#6c6a64",
      bold: "#252523",
      italic: "#3d3d3a",
      code: "#a9583e",
      highlight: "#141413",
      comment: "#8c857a",
    });
    expect(claude.radii).toEqual({ md: "8px", lg: "12px", xl: "16px" });
    expect(claude.font).toEqual({ sans: '"Inter", system-ui, sans-serif' });
  });

  it("claude is a complete theme that survives strict parse (core 8 non-empty)", () => {
    const claude = builtInTheme("claude");
    // round-trip through serialize→parse leaves it unchanged: the explicit extended
    // values are preserved (not re-derived to the fallback), proving claude carries
    // its own editorial tones, not promoteToExtended echoes.
    expect(parseTheme(serializeTheme(claude))).toEqual(claude);
  });

  it("no builtin theme's core+legacy-extended 18 values changed a single character (zero-drift gate)", () => {
    // A hardcoded snapshot of the 18 pre-2026-08 keys per preset. If this test
    // fails, someone edited an EXISTING color while adding the new comment/
    // background keys — that's the exact regression this gate exists to catch.
    const LEGACY_18: Record<string, Record<string, string>> = {
      dark: {
        bg: "#131110", fg: "#ffffff", accent: "#a8c8e8", link: "#a8c8e8",
        surface: "#1c1917", border: "rgba(255,255,255,.12)", muted: "#a8a29e", highlightBg: "#ffe066",
        h1: "#ffffff", h2: "#ffffff", h3: "#ffffff", h4: "#ffffff", h5: "#ffffff", h6: "#a8a29e",
        bold: "#ffffff", italic: "#ffffff", code: "#a8c8e8", highlight: "#1a1300",
      },
      light: {
        bg: "#f5f5f5", fg: "#0c0a09", accent: "#292524", link: "#1d6fb8",
        surface: "#ffffff", border: "#e7e5e4", muted: "#777169", highlightBg: "#fff3a3",
        h1: "#0c0a09", h2: "#0c0a09", h3: "#0c0a09", h4: "#0c0a09", h5: "#0c0a09", h6: "#777169",
        bold: "#0c0a09", italic: "#0c0a09", code: "#292524", highlight: "#1a1300",
      },
      claude: {
        bg: "#faf9f5", fg: "#141413", accent: "#cc785c", link: "#a9583e",
        surface: "#efe9de", border: "#e6dfd8", muted: "#6c6a64", highlightBg: "#f0d9a8",
        h1: "#141413", h2: "#141413", h3: "#141413", h4: "#141413", h5: "#141413", h6: "#6c6a64",
        bold: "#252523", italic: "#3d3d3a", code: "#a9583e", highlight: "#141413",
      },
    };
    for (const name of ["dark", "light", "claude"] as const) {
      const colors = builtInTheme(name).colors as Record<string, string>;
      for (const [key, expected] of Object.entries(LEGACY_18[name])) {
        expect(colors[key]).toBe(expected);
      }
    }
  });
});

describe("comment color: independent from muted, with a targeted contrast band (결정 5)", () => {
  const CASES = [
    { name: "light" as const, bg: "#f5f5f5", fg: "#0c0a09" },
    { name: "claude" as const, bg: "#faf9f5", fg: "#141413" },
    { name: "dark" as const, bg: "#131110", fg: "#ffffff" },
  ];

  it.each(CASES)("$name: comment:bg contrast is >= 3.0 (WCAG AA large-text floor)", ({ name, bg }) => {
    const t = builtInTheme(name);
    expect(contrastRatio(t.colors.comment!, bg)).toBeGreaterThanOrEqual(3.0);
  });

  it.each(CASES)("$name: comment sits closer to bg than muted does (an aside, not a duplicate of body text)", ({ name, bg }) => {
    const t = builtInTheme(name);
    expect(contrastRatio(t.colors.comment!, bg)).toBeLessThan(contrastRatio(t.colors.muted, bg));
  });

  it.each(CASES)("$name: comment is clearly separated from fg (>= 5:1, the reported bug's fix)", ({ name, fg }) => {
    const t = builtInTheme(name);
    expect(contrastRatio(t.colors.comment!, fg)).toBeGreaterThanOrEqual(5.0);
  });
});

describe("upgradePristinePreset: only an untouched preset is upgraded", () => {
  it("an old 18-key light JSON (no new-gen keys, values untouched) is upgraded to the fresh builtin (gains comment)", () => {
    const legacy = builtInTheme("light");
    // Simulate an old saved theme: strip the new-gen keys (as a pre-2026-08 save
    // would never have had them).
    const { comment: _c, ...oldColors } = legacy.colors;
    const oldRaw = { ...legacy, colors: oldColors };
    const parsed = parseTheme(JSON.stringify(oldRaw));
    expect(parsed!.colors.comment).toBe("#8f887e"); // gained the new default
    expect(parsed!.name).toBe("light");
  });

  it("a light theme with even one edited legacy color is left untouched (no comment upgrade)", () => {
    const legacy = builtInTheme("light");
    const { comment: _c, ...oldColors } = legacy.colors;
    const customized = { ...legacy, colors: { ...oldColors, fg: "#123456" } }; // user recolored fg
    const parsed = parseTheme(JSON.stringify(customized));
    // Falls back through promoteToExtended (comment ← muted), NOT the fresh preset.
    expect(parsed!.colors.comment).toBe(parsed!.colors.muted);
    expect(parsed!.colors.fg).toBe("#123456"); // the user's edit survives
  });

  it("a theme already carrying a new-gen key is never re-upgraded (idempotent)", () => {
    const legacy = builtInTheme("light");
    const { comment: _c, ...oldColors } = legacy.colors;
    const alreadyUpgraded = { ...legacy, colors: { ...oldColors, comment: "#111111" } }; // user's own comment choice
    const parsed = parseTheme(JSON.stringify(alreadyUpgraded));
    expect(parsed!.colors.comment).toBe("#111111"); // NOT overwritten back to #8f887e
  });

  it("a custom-named theme (not dark/light/claude) is never upgraded, no matter its values", () => {
    const custom = { ...builtInTheme("light"), name: "my-theme" };
    const { comment: _c, ...oldColors } = custom.colors;
    const parsed = parseTheme(JSON.stringify({ ...custom, colors: oldColors }));
    expect(parsed!.name).toBe("my-theme");
    expect(parsed!.colors.comment).toBe(parsed!.colors.muted); // fallback, not the light preset's #8f887e
  });

  it("upgradePristinePreset itself: pure function, direct calls", () => {
    const light = builtInTheme("light");
    expect(upgradePristinePreset(light, [], false)).toEqual(light); // no new-gen keys in raw → but already matches itself
    expect(upgradePristinePreset({ ...light, name: "custom" }, [], false)).toEqual({ ...light, name: "custom" });
  });

  // 2026-08 audit blocker #2 (04_ui_audit.md): pristine judged colors alone, so a
  // theme with untouched colors but a hand-edited radii/font.sans (both are
  // legitimately editable via the JSON accordion) was misjudged pristine and its
  // radii/font were silently clobbered back to the preset default on the next
  // parse. Both fields are now part of the pristine check.
  it("a light theme with an edited radius (colors untouched) is left untouched — radii survives (audit blocker #2)", () => {
    const legacy = builtInTheme("light");
    const { comment: _c, ...oldColors } = legacy.colors;
    const edited = { ...legacy, colors: oldColors, radii: { ...legacy.radii, md: "2px" } };
    const parsed = parseTheme(JSON.stringify(edited));
    expect(parsed!.radii.md).toBe("2px"); // the user's edit survives, not silently reset to 8px
    expect(parsed!.radii.lg).toBe(legacy.radii.lg); // untouched radii keys are unaffected either way
    // Not upgraded, so comment falls back through promoteToExtended (← muted),
    // same as any other non-pristine (customized) theme.
    expect(parsed!.colors.comment).toBe(parsed!.colors.muted);
  });

  it("a light theme with an edited font.sans (colors untouched) is left untouched — font survives (audit blocker #2)", () => {
    const legacy = builtInTheme("light");
    const { comment: _c, ...oldColors } = legacy.colors;
    const edited = { ...legacy, colors: oldColors, font: { sans: "serif" } };
    const parsed = parseTheme(JSON.stringify(edited));
    expect(parsed!.font.sans).toBe("serif"); // the user's edit survives, not silently reset to Inter
    expect(parsed!.colors.comment).toBe(parsed!.colors.muted);
  });

  it("a colors-only edit still blocks upgrade exactly as before (radii/font check doesn't loosen the colors gate)", () => {
    const legacy = builtInTheme("light");
    const { comment: _c, ...oldColors } = legacy.colors;
    const edited = { ...legacy, colors: { ...oldColors, fg: "#123456" } }; // radii/font untouched, one color edited
    const parsed = parseTheme(JSON.stringify(edited));
    expect(parsed!.colors.fg).toBe("#123456");
    expect(parsed!.radii).toEqual(legacy.radii); // radii/font untouched → same values either branch
    expect(parsed!.font).toEqual(legacy.font);
  });

  it("truly pristine (colors AND radii AND font all untouched) still upgrades and gains comment", () => {
    const legacy = builtInTheme("light");
    const { comment: _c, ...oldColors } = legacy.colors;
    const pristine = { ...legacy, colors: oldColors };
    const parsed = parseTheme(JSON.stringify(pristine));
    expect(parsed!.colors.comment).toBe("#8f887e"); // upgrade still happens when NOTHING was touched
    expect(parsed!.radii).toEqual(legacy.radii);
    expect(parsed!.font).toEqual(legacy.font);
  });
});

describe("background keys: parse/serialize round-trip and the 'absence = no background' invariant", () => {
  it("parseTheme leaves an old JSON with no background keys entirely undefined for all 11", () => {
    const legacy = builtInTheme("dark");
    const parsed = parseTheme(JSON.stringify(legacy))!;
    for (const key of ["boldBg", "italicBg", "codeBg", "linkBg", "commentBg", "h1Bg", "h2Bg", "h3Bg", "h4Bg", "h5Bg", "h6Bg"] as const) {
      expect(parsed.colors[key]).toBeUndefined();
    }
  });

  it("parseTheme preserves an explicit background value", () => {
    const legacy = builtInTheme("dark");
    const withBg = { ...legacy, colors: { ...legacy.colors, boldBg: "#ff00ff" } };
    const parsed = parseTheme(JSON.stringify(withBg))!;
    expect(parsed.colors.boldBg).toBe("#ff00ff");
  });

  it("parseTheme treats an empty-string background value as absent (never rejects the whole theme)", () => {
    const legacy = builtInTheme("dark");
    const broken = { ...legacy, colors: { ...legacy.colors, boldBg: "" } };
    const parsed = parseTheme(JSON.stringify(broken));
    expect(parsed).not.toBeNull(); // theme still parses
    expect(parsed!.colors.boldBg).toBeUndefined(); // empty treated as absent
  });

  it("serializeTheme drops an absent background key entirely (no key in the JSON, not a null/'' value)", () => {
    const t: Theme = { ...validTheme, colors: { ...validTheme.colors } };
    const text = serializeTheme(t);
    expect(JSON.parse(text).colors).not.toHaveProperty("boldBg");
  });

  it("serializeTheme keeps an explicit background key", () => {
    const t: Theme = { ...validTheme, colors: { ...validTheme.colors, boldBg: "#ff00ff" } };
    const text = serializeTheme(t);
    expect(JSON.parse(text).colors.boldBg).toBe("#ff00ff");
  });
});

// 2026-08 round 2 (01_ui2_plan.md 갈래 A1): the 9 new keys share the exact same
// "absent = undefined, never rejects, never promotes" contract as round 1's 11 —
// these tests exercise the round-2-specific keys through that same contract.
describe("round-2 optional keys (boldItalic/strike/quote/codeBlock family): parse/serialize round-trip", () => {
  it("parseTheme leaves an old JSON with none of the 9 new keys entirely undefined", () => {
    const legacy = builtInTheme("dark");
    const parsed = parseTheme(JSON.stringify(legacy))!;
    for (const key of ["boldItalic", "boldItalicBg", "strike", "strikeBg", "quote", "quoteBg", "quoteBar", "codeBlock", "codeBlockBg"] as const) {
      expect(parsed.colors[key]).toBeUndefined();
    }
  });

  it("parseTheme preserves an explicit quoteBg value", () => {
    const legacy = builtInTheme("dark");
    const withQuoteBg = { ...legacy, colors: { ...legacy.colors, quoteBg: "#123456" } };
    const parsed = parseTheme(JSON.stringify(withQuoteBg))!;
    expect(parsed.colors.quoteBg).toBe("#123456");
  });

  it("parseTheme treats an empty-string quoteBar value as absent (never rejects the whole theme)", () => {
    const legacy = builtInTheme("dark");
    const broken = { ...legacy, colors: { ...legacy.colors, quoteBar: "" } };
    const parsed = parseTheme(JSON.stringify(broken));
    expect(parsed).not.toBeNull();
    expect(parsed!.colors.quoteBar).toBeUndefined();
  });

  it("serializeTheme drops an absent round-2 key entirely, keeps an explicit one", () => {
    const withoutIt: Theme = { ...validTheme, colors: { ...validTheme.colors } };
    expect(JSON.parse(serializeTheme(withoutIt)).colors).not.toHaveProperty("codeBlockBg");

    const withIt: Theme = { ...validTheme, colors: { ...validTheme.colors, codeBlockBg: "#ff00ff" } };
    expect(JSON.parse(serializeTheme(withIt)).colors.codeBlockBg).toBe("#ff00ff");
  });

  // The round-1 audit's blocker #2 failure class, reincarnated for round 2: a
  // theme whose colors/radii/font are ALL byte-identical to the light preset
  // (so upgradePristinePreset's other checks pass) but which sets quoteBg must
  // NOT be judged pristine — otherwise the very next parse silently destroys
  // quoteBg by replacing the whole colors object with the fresh preset's (which
  // has no quoteBg). NEW_GEN_KEYS spreading OPTIONAL_KEYS (rather than being a
  // hand-maintained list) is what makes this pass automatically.
  it("a light-preset JSON with only quoteBg set is NOT misjudged pristine — quoteBg survives (round-2 blocker-#2 regression)", () => {
    const legacy = builtInTheme("light");
    const withQuoteBg = { ...legacy, colors: { ...legacy.colors, quoteBg: "#654321" } };
    const parsed = parseTheme(JSON.stringify(withQuoteBg));
    expect(parsed!.colors.quoteBg).toBe("#654321"); // NOT destroyed by a false-pristine upgrade
    expect(parsed!.name).toBe("light");
  });

  it("NEW_GEN_KEYS includes every round-2 key (structural check via upgradePristinePreset behavior)", () => {
    // Indirect but precise: if any round-2 key were missing from NEW_GEN_KEYS,
    // a raw JSON carrying ONLY that key (colors otherwise untouched from the
    // preset) would be misjudged pristine and upgraded, silently dropping it.
    const legacy = builtInTheme("light");
    for (const key of ["boldItalic", "boldItalicBg", "strike", "strikeBg", "quote", "quoteBg", "quoteBar", "codeBlock", "codeBlockBg"] as const) {
      const withKey = { ...legacy, colors: { ...legacy.colors, [key]: "#abcdef" } };
      const parsed = parseTheme(JSON.stringify(withKey));
      expect(parsed!.colors[key], `${key} was destroyed by a false-pristine upgrade`).toBe("#abcdef");
    }
  });
});

// ── highlightBlockBg (2026-08 round 3, "```highlight 블록이 테마 대상에서
// 빠졌다") — same OPTIONAL_KEYS "auto" family as quoteBg/codeBlockBg. ──
describe("highlightBlockBg (round 3): OPTIONAL_KEYS 'auto' family, same contract as quoteBg/codeBlockBg", () => {
  it("isOptionalKey/absentKind classify it as an 'auto' optional key", () => {
    expect(isOptionalKey("highlightBlockBg")).toBe(true);
    expect(absentKind("highlightBlockBg")).toBe("auto");
  });

  it("resolveOptional: absent → 'initial', explicit value passes through verbatim", () => {
    expect(resolveOptional("highlightBlockBg", undefined)).toBe("initial");
    expect(resolveOptional("highlightBlockBg", "#ff00ff")).toBe("#ff00ff");
  });

  it("themeToVars always emits --highlightblock-bg (absent → 'initial')", () => {
    const vars = themeToVars(promotedTheme);
    expect(vars["--highlightblock-bg"]).toBe("initial");
    const withIt = themeToVars({ ...promotedTheme, colors: { ...promotedTheme.colors, highlightBlockBg: "#00ffaa" } });
    expect(withIt["--highlightblock-bg"]).toBe("#00ffaa");
  });

  it("parse/serialize round-trip: presence and absence survive", () => {
    expect(JSON.parse(serializeTheme(promotedTheme)).colors).not.toHaveProperty("highlightBlockBg");
    const withIt: Theme = { ...promotedTheme, colors: { ...promotedTheme.colors, highlightBlockBg: "#123123" } };
    expect(JSON.parse(serializeTheme(withIt)).colors.highlightBlockBg).toBe("#123123");
    const parsed = parseTheme(serializeTheme(withIt));
    expect(parsed!.colors.highlightBlockBg).toBe("#123123");
  });

  it("parseTheme treats a corrupt/empty highlightBlockBg as absent, never rejects the whole theme", () => {
    const legacy = builtInTheme("dark");
    const broken = { ...legacy, colors: { ...legacy.colors, highlightBlockBg: "" } };
    const parsed = parseTheme(JSON.stringify(broken));
    expect(parsed).not.toBeNull();
    expect(parsed!.colors.highlightBlockBg).toBeUndefined();
  });

  it("a legacy 8-key theme (no highlightBlockBg at all) still parses fine (backward compat)", () => {
    const parsed = parseTheme(JSON.stringify(validTheme));
    expect(parsed).not.toBeNull();
    expect(parsed!.colors.highlightBlockBg).toBeUndefined();
  });

  it("a light-preset JSON with only highlightBlockBg set is NOT misjudged pristine (blocker-#2 regression class)", () => {
    const legacy = builtInTheme("light");
    const withKey = { ...legacy, colors: { ...legacy.colors, highlightBlockBg: "#654321" } };
    const parsed = parseTheme(JSON.stringify(withKey));
    expect(parsed!.colors.highlightBlockBg).toBe("#654321");
    expect(parsed!.name).toBe("light");
  });
});

// ── Block geometry: Theme.geometry?.blockRadius/blockPadding (design §3) ──
describe("block geometry (blockRadius/blockPadding): shared 2-key OPTIONAL-mirror section", () => {
  it("isSingleToken: a single CSS length token is valid, a multi-token value is rejected", () => {
    expect(isSingleToken("12px")).toBe(true);
    expect(isSingleToken("0.7em")).toBe(true);
    expect(isSingleToken(".5em 1em")).toBe(false); // the blockquote padding-left collapse trap
    expect(isSingleToken("")).toBe(false);
    expect(isSingleToken("   ")).toBe(false);
    expect(isSingleToken(undefined)).toBe(false);
    expect(isSingleToken(42)).toBe(false);
  });

  it("resolveGeometry: absent → 'initial', explicit value passes through verbatim", () => {
    expect(resolveGeometry("blockRadius", undefined)).toBe("initial");
    expect(resolveGeometry("blockRadius", "12px")).toBe("12px");
    expect(resolveGeometry("blockPadding", undefined)).toBe("initial");
  });

  it("themeToVars always emits --block-radius/--block-padding (absent → 'initial')", () => {
    const vars = themeToVars(promotedTheme);
    expect(vars["--block-radius"]).toBe("initial");
    expect(vars["--block-padding"]).toBe("initial");
    const withIt = themeToVars({ ...promotedTheme, geometry: { blockRadius: "12px", blockPadding: "1em" } });
    expect(withIt["--block-radius"]).toBe("12px");
    expect(withIt["--block-padding"]).toBe("1em");
  });

  it("parseTheme accepts a valid single-token geometry value", () => {
    const withGeo = { ...promotedTheme, geometry: { blockRadius: "12px" } };
    const parsed = parseTheme(JSON.stringify(withGeo));
    expect(parsed!.geometry?.blockRadius).toBe("12px");
    expect(parsed!.geometry?.blockPadding).toBeUndefined();
  });

  it("parseTheme treats a 2-value (space-containing) blockPadding as ABSENT — never rejects the theme (isSingleToken guard)", () => {
    const withGeo = { ...promotedTheme, geometry: { blockPadding: ".5em 1em" } };
    const parsed = parseTheme(JSON.stringify(withGeo));
    expect(parsed).not.toBeNull();
    expect(parsed!.geometry?.blockPadding).toBeUndefined();
  });

  it("parseTheme treats a non-string/empty geometry value as absent, never rejects", () => {
    const withGeo = { ...promotedTheme, geometry: { blockRadius: "", blockPadding: 12 } };
    const parsed = parseTheme(JSON.stringify(withGeo));
    expect(parsed).not.toBeNull();
    expect(parsed!.geometry).toBeUndefined(); // both keys invalid → no geometry section at all
  });

  it("serializeTheme omits the whole `geometry` key when both keys are absent (legacy JSON byte round-trip)", () => {
    expect(JSON.parse(serializeTheme(promotedTheme))).not.toHaveProperty("geometry");
    const parsed = parseTheme(serializeTheme(promotedTheme));
    expect(JSON.parse(serializeTheme(parsed!))).not.toHaveProperty("geometry");
  });

  it("serializeTheme keeps an explicitly-set geometry key, round-trips through parseTheme", () => {
    const withGeo: Theme = { ...promotedTheme, geometry: { blockRadius: "14px", blockPadding: "1em" } };
    const json = serializeTheme(withGeo);
    expect(JSON.parse(json).geometry).toEqual({ blockRadius: "14px", blockPadding: "1em" });
    const parsed = parseTheme(json);
    expect(parsed!.geometry).toEqual({ blockRadius: "14px", blockPadding: "1em" });
  });

  it("a legacy theme JSON with no `geometry` key at all still parses fine (backward compat)", () => {
    const parsed = parseTheme(JSON.stringify(validTheme));
    expect(parsed).not.toBeNull();
    expect(parsed!.geometry).toBeUndefined();
  });

  // design §3's function-#2 trap: pristine judged colors alone would let a
  // preset-colors-untouched theme with ONLY geometry.blockRadius set be
  // misjudged pristine, and the next parse silently drops blockRadius by
  // replacing the whole theme with the fresh preset (which has no geometry).
  it("a light-preset JSON with only geometry.blockRadius set is NOT misjudged pristine — geometry survives", () => {
    const legacy = builtInTheme("light");
    const withGeo = { ...legacy, geometry: { blockRadius: "12px" } };
    const parsed = parseTheme(JSON.stringify(withGeo));
    expect(parsed!.geometry?.blockRadius).toBe("12px"); // NOT destroyed by a false-pristine upgrade
    expect(parsed!.name).toBe("light");
  });

  it("upgradePristinePreset itself: rawHasGeometry=true blocks the upgrade even with an otherwise-pristine theme", () => {
    const light = builtInTheme("light");
    const { comment: _c, ...oldColors } = light.colors;
    const pristineColors = { ...light, colors: oldColors };
    // Without geometry flag: upgrades (gains comment default).
    expect(upgradePristinePreset(pristineColors, [], false).colors.comment).toBe(light.colors.comment);
    // With geometry flag: left untouched (colors keep the promoteToExtended fallback, not the preset's).
    const untouched = upgradePristinePreset(pristineColors, [], true);
    expect(untouched).toEqual(pristineColors);
  });

  it("a truly pristine theme (no geometry touched) still upgrades as before — the geometry gate doesn't loosen the existing gates", () => {
    const legacy = builtInTheme("light");
    const { comment: _c, ...oldColors } = legacy.colors;
    const pristine = { ...legacy, colors: oldColors };
    const parsed = parseTheme(JSON.stringify(pristine));
    expect(parsed!.colors.comment).toBe("#8f887e");
    expect(parsed!.geometry).toBeUndefined();
  });
});
