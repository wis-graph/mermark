import { describe, it, expect } from "vitest";
import {
  builtInTheme,
  parseTheme,
  promoteToExtended,
  serializeTheme,
  themeToVars,
  type Theme,
} from "../src/settings/theme-schema";

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
  it("produces all 22 vars (12 base + 10 extended via the fallback rule)", () => {
    const vars = themeToVars(validTheme); // 8-key input → extended vars come from fallback
    expect(vars).toEqual({
      "--bg": "#111111",
      "--fg": "#eeeeee",
      "--accent": "#abcdef",
      "--link": "#123456",
      "--surface": "#222222",
      "--border": "#333333",
      "--muted": "#999999",
      "--highlight-bg": "#ffff00",
      // extended: h1~h5/bold/italic → fg, h6 → muted, code → accent, highlight ink
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

  it("does not introduce --radius-sm (styles.css never defines it)", () => {
    expect(themeToVars(validTheme)).not.toHaveProperty("--radius-sm");
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
    });
    expect(dark.radii).toEqual({ md: "8px", lg: "12px", xl: "16px" });
    expect(dark.font).toEqual({ sans: '"Inter", system-ui, sans-serif' });
  });

  it("dark's explicit extended values match the fallback rule applied to its core", () => {
    const dark = builtInTheme("dark");
    expect(dark.colors).toEqual({ ...dark.colors, ...promoteToExtended(dark.colors) });
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
    });
    expect(claude.radii).toEqual({ md: "8px", lg: "12px", xl: "16px" });
    expect(claude.font).toEqual({ sans: '"Inter", system-ui, sans-serif' });
  });

  it("claude is a complete 18-key theme that survives strict parse (core 8 non-empty)", () => {
    const claude = builtInTheme("claude");
    // round-trip through serialize→parse leaves it unchanged: the explicit extended
    // values are preserved (not re-derived to the fallback), proving claude carries
    // its own editorial tones, not promoteToExtended echoes.
    expect(parseTheme(serializeTheme(claude))).toEqual(claude);
  });
});
