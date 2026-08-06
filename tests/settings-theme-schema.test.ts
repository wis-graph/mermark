import { describe, it, expect } from "vitest";
import {
  builtInTheme,
  parseTheme,
  promoteToExtended,
  resolveBackground,
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
      "--radius-md": "8px",
      "--radius-lg": "12px",
      "--radius-xl": "16px",
      "--font-sans": "Inter, sans-serif",
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

  it("always emits all 11 background vars, never conditionally (stale-var guard)", () => {
    const withNone = themeToVars(validTheme);
    const withOne = themeToVars({ ...validTheme, colors: { ...validTheme.colors, h1Bg: "#123" } });
    // Every background key present in BOTH outputs — switching themes can never
    // leave a background var missing from the map (themeVarsSink only overwrites).
    for (const key of ["--bold-bg", "--italic-bg", "--code-bg", "--link-bg", "--comment-bg",
      "--h1-bg", "--h2-bg", "--h3-bg", "--h4-bg", "--h5-bg", "--h6-bg"]) {
      expect(withNone).toHaveProperty(key);
      expect(withOne).toHaveProperty(key);
    }
    expect(withOne["--h1-bg"]).toBe("#123");
  });

  it("does not introduce --radius-sm (styles.css never defines it)", () => {
    expect(themeToVars(validTheme)).not.toHaveProperty("--radius-sm");
  });
});

describe("resolveBackground: 배경 없음이 무엇으로 렌더되는가", () => {
  it("codeBg resolves to the surface-veil chip fill when unset (zero-drift for the existing inline-code chip)", () => {
    expect(resolveBackground("codeBg", undefined)).toBe("var(--surface-veil)");
  });

  it("every other background key resolves to transparent when unset", () => {
    for (const key of ["boldBg", "italicBg", "linkBg", "commentBg", "h1Bg", "h2Bg", "h3Bg", "h4Bg", "h5Bg", "h6Bg"] as const) {
      expect(resolveBackground(key, undefined)).toBe("transparent");
    }
  });

  it("an explicit value always wins over the intrinsic default", () => {
    expect(resolveBackground("codeBg", "#abcdef")).toBe("#abcdef");
    expect(resolveBackground("boldBg", "#abcdef")).toBe("#abcdef");
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
    expect(upgradePristinePreset(light, [])).toEqual(light); // no new-gen keys in raw → but already matches itself
    expect(upgradePristinePreset({ ...light, name: "custom" }, [])).toEqual({ ...light, name: "custom" });
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
