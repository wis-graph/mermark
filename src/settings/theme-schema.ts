// A theme is ONE plain-data JSON document: the whole token set as a single
// identity the user can bulk import/export. All values are CSS strings (color /
// length / font-stack) so the schema is hand-editable in a <textarea>. The
// built-in dark/light presets are copied verbatim from styles.css:1-28 so
// adopting the JSON model causes zero visual drift.

/** The names of the two built-in presets (distinct from the JSON Theme below). */
export type PresetName = "dark" | "light";

export interface Theme {
  /** "dark" | "light" | a user name — free-form identity for the theme. */
  name: string;
  colors: {
    bg: string;
    fg: string;
    accent: string;
    link: string;
    surface: string;
    border: string;
    muted: string;
    highlightBg: string;
  };
  /** --radius-md/lg/xl. (No --radius-sm: styles.css only fallback-references it.) */
  radii: { md: string; lg: string; xl: string };
  /** --font-sans (a CSS font stack). */
  font: { sans: string };
}

const COLOR_KEYS = [
  "bg",
  "fg",
  "accent",
  "link",
  "surface",
  "border",
  "muted",
  "highlightBg",
] as const;
const RADII_KEYS = ["md", "lg", "xl"] as const;

/** The "valid CSS string token" rule: non-empty string. Used uniformly for every
 *  color/radius/font field so the import-validation rule lives once. */
function isToken(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** The import-validation rule, named once: parse a JSON string into a Theme,
 *  rejecting malformed input (bad JSON, missing/empty/non-string fields) by
 *  returning null. A null result lets defineSetting fall back to the default —
 *  a corrupt paste never poisons the SSOT. Pure query (no side effects). */
export function parseTheme(raw: string | null): Theme | null {
  if (raw == null) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const t = obj as Record<string, unknown>;
  if (typeof t.name !== "string") return null;

  const colors = t.colors;
  if (typeof colors !== "object" || colors === null) return null;
  const c = colors as Record<string, unknown>;
  for (const k of COLOR_KEYS) if (!isToken(c[k])) return null;

  const radii = t.radii;
  if (typeof radii !== "object" || radii === null) return null;
  const r = radii as Record<string, unknown>;
  for (const k of RADII_KEYS) if (!isToken(r[k])) return null;

  const font = t.font;
  if (typeof font !== "object" || font === null) return null;
  if (!isToken((font as Record<string, unknown>).sans)) return null;

  return {
    name: t.name,
    colors: {
      bg: c.bg as string,
      fg: c.fg as string,
      accent: c.accent as string,
      link: c.link as string,
      surface: c.surface as string,
      border: c.border as string,
      muted: c.muted as string,
      highlightBg: c.highlightBg as string,
    },
    radii: { md: r.md as string, lg: r.lg as string, xl: r.xl as string },
    font: { sans: (font as { sans: string }).sans },
  };
}

/** Pretty-printed (2-space) JSON so the textarea is human-editable. Used as the
 *  setting's serialize. Pure query. */
export function serializeTheme(t: Theme): string {
  return JSON.stringify(t, null, 2);
}

/** The single source of which CSS var each theme field drives (the mapping
 *  table). Pure query — themeVarsSink fans this onto documentElement. Note: no
 *  --radius-sm (styles.css never defines it; only fallback-references it), so
 *  emitting one would itself be drift. */
export function themeToVars(t: Theme): Record<string, string> {
  return {
    "--bg": t.colors.bg,
    "--fg": t.colors.fg,
    "--accent": t.colors.accent,
    "--link": t.colors.link,
    "--surface": t.colors.surface,
    "--border": t.colors.border,
    "--muted": t.colors.muted,
    "--highlight-bg": t.colors.highlightBg,
    "--radius-md": t.radii.md,
    "--radius-lg": t.radii.lg,
    "--radius-xl": t.radii.xl,
    "--font-sans": t.font.sans,
  };
}

// Shared by both presets: styles.css declares radii + font only on :root (lines
// 13-16), and the light block (18-28) does NOT re-declare them, so light
// inherits these exact values. Copying them into both presets keeps zero-drift.
const SHARED_RADII = { md: "8px", lg: "12px", xl: "16px" } as const;
const SHARED_FONT = { sans: '"Inter", system-ui, sans-serif' } as const;

/** The two presets, with colors taken verbatim from styles.css:1-28. Pure
 *  query — the preset picker (loadPreset) writes builtInTheme(name) into the
 *  JSON setting, which keeps the visual output byte-identical to the current
 *  CSS (the zero-drift invariant). */
export function builtInTheme(name: PresetName): Theme {
  if (name === "light") {
    return {
      name: "light",
      colors: {
        bg: "#f5f5f5",
        fg: "#0c0a09",
        accent: "#292524",
        link: "#1d6fb8",
        surface: "#ffffff",
        border: "#e7e5e4",
        muted: "#777169",
        highlightBg: "#fff3a3",
      },
      radii: { ...SHARED_RADII },
      font: { ...SHARED_FONT },
    };
  }
  return {
    name: "dark",
    colors: {
      bg: "#0c0a09",
      fg: "#ffffff",
      accent: "#a8c8e8",
      link: "#a8c8e8",
      surface: "#1c1917",
      border: "rgba(255,255,255,.12)",
      muted: "#a8a29e",
      highlightBg: "#ffe066",
    },
    radii: { ...SHARED_RADII },
    font: { ...SHARED_FONT },
  };
}
