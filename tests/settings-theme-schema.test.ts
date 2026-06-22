import { describe, it, expect } from "vitest";
import {
  builtInTheme,
  parseTheme,
  serializeTheme,
  themeToVars,
  type Theme,
} from "../src/settings/theme-schema";

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

describe("parseTheme", () => {
  it("accepts a valid theme JSON string and returns a Theme", () => {
    const parsed = parseTheme(JSON.stringify(validTheme));
    expect(parsed).toEqual(validTheme);
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
  it("round-trips a theme through serialize → parse unchanged", () => {
    const text = serializeTheme(validTheme);
    expect(parseTheme(text)).toEqual(validTheme);
  });

  it("serializes as 2-space pretty JSON (human-editable textarea)", () => {
    const text = serializeTheme(validTheme);
    expect(text).toContain('\n  "name"'); // 2-space indent
    expect(JSON.parse(text)).toEqual(validTheme);
  });

  it("round-trips the built-in themes byte-for-byte", () => {
    for (const name of ["dark", "light"] as const) {
      const t = builtInTheme(name);
      expect(parseTheme(serializeTheme(t))).toEqual(t);
    }
  });
});

describe("themeToVars maps every field to the right CSS var", () => {
  it("produces all 12 vars from the mapping table", () => {
    const vars = themeToVars(validTheme);
    expect(vars).toEqual({
      "--bg": "#111111",
      "--fg": "#eeeeee",
      "--accent": "#abcdef",
      "--link": "#123456",
      "--surface": "#222222",
      "--border": "#333333",
      "--muted": "#999999",
      "--highlight-bg": "#ffff00",
      "--radius-md": "8px",
      "--radius-lg": "12px",
      "--radius-xl": "16px",
      "--font-sans": "Inter, sans-serif",
    });
  });

  it("does not introduce --radius-sm (styles.css never defines it)", () => {
    expect(themeToVars(validTheme)).not.toHaveProperty("--radius-sm");
  });
});

describe("builtInTheme equals the current styles.css values (zero-drift)", () => {
  it("dark matches styles.css:4-16 exactly", () => {
    const dark = builtInTheme("dark");
    expect(dark.colors).toEqual({
      bg: "#0c0a09",
      fg: "#ffffff",
      accent: "#a8c8e8",
      link: "#a8c8e8",
      surface: "#1c1917",
      border: "rgba(255,255,255,.12)",
      muted: "#a8a29e",
      highlightBg: "#ffe066",
    });
    expect(dark.radii).toEqual({ md: "8px", lg: "12px", xl: "16px" });
    expect(dark.font).toEqual({ sans: '"Inter", system-ui, sans-serif' });
  });

  it("light matches styles.css:19-27 exactly", () => {
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
    });
  });

  it("light inherits dark's radii/font (styles.css light block does not re-declare them)", () => {
    const dark = builtInTheme("dark");
    const light = builtInTheme("light");
    expect(light.radii).toEqual(dark.radii);
    expect(light.font).toEqual(dark.font);
  });
});
