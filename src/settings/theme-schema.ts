// A theme is ONE plain-data JSON document: the whole token set as a single
// identity the user can bulk import/export. All values are CSS strings (color /
// length / font-stack) so the schema is hand-editable in a <textarea>. The
// built-in dark/light presets are copied verbatim from styles.css:1-28 so
// adopting the JSON model causes zero visual drift.

/** The names of the built-in presets (distinct from the JSON Theme below). */
export type PresetName = "dark" | "light" | "claude";

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
    // Extended per-element colors. OPTIONAL on the interface so a legacy 8-key
    // theme (saved by an older build) still type-checks as Theme — backward
    // compatibility is the reason these are `?`. parseTheme/builtInTheme always
    // emit them filled (promoteToExtended), so downstream readers can rely on
    // their presence; the optionality is an INPUT contract, not an output one.
    h1?: string;
    h2?: string;
    h3?: string;
    h4?: string;
    h5?: string;
    h6?: string;
    bold?: string;
    italic?: string;
    code?: string;
    highlight?: string;
  };
  /** --radius-md/lg/xl. (No --radius-sm: styles.css only fallback-references it.) */
  radii: { md: string; lg: string; xl: string };
  /** --font-sans (a CSS font stack). */
  font: { sans: string };
}

// The 8 CORE color keys. STRICT: parseTheme rejects a value missing any of these
// (SSOT integrity). NEVER add an extended key here — doing so would make every
// legacy 8-key localStorage theme fail to parse and silently reset to default.
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

/** The 10 EXTENDED (per-element) color keys. Optional on input, always filled on
 *  output. Distinct from COLOR_KEYS so the strict-reject loop never touches them
 *  (backward compat: a corrupt/absent extended key falls back, never rejects). */
export const EXTENDED_KEYS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "bold",
  "italic",
  "code",
  "highlight",
] as const;
export type ExtendedKey = (typeof EXTENDED_KEYS)[number];

/** The 8 core colors an extended key may derive its fallback from. */
type CoreColors = Pick<Theme["colors"], (typeof COLOR_KEYS)[number]>;

// The SINGLE source of "what color does a missing/corrupt extended key inherit?"
// — the promote-legacy-to-extended rule, as data. h1~h5/bold/italic → fg, h6 →
// muted, code → accent, highlight → a fixed dark ink (matches the .cm-highlight
// ink in styles.css, legible on both light + dark). promoteToExtended is the
// ONLY caller, so this rule lives in exactly one place (no scattered fallbacks).
const HIGHLIGHT_INK = "#1a1300";
const EXTENDED_FALLBACK: Record<ExtendedKey, (core: CoreColors) => string> = {
  h1: (c) => c.fg,
  h2: (c) => c.fg,
  h3: (c) => c.fg,
  h4: (c) => c.fg,
  h5: (c) => c.fg,
  h6: (c) => c.muted,
  bold: (c) => c.fg,
  italic: (c) => c.fg,
  code: (c) => c.accent,
  highlight: () => HIGHLIGHT_INK,
};

/** Promote a 8-key core palette to the full 18-key set: keep any valid explicit
 *  extended value from `explicit`, fall back per EXTENDED_FALLBACK otherwise. A
 *  corrupt/empty extended value is treated as absent (fallback) — never a reject,
 *  so one damaged partial key can't drop the whole theme to default. Pure query;
 *  the named "upgrade an old theme to extended" rule, in one place. */
export function promoteToExtended(
  core: CoreColors,
  explicit?: Partial<Record<ExtendedKey, unknown>>,
): Record<ExtendedKey, string> {
  const out = {} as Record<ExtendedKey, string>;
  for (const key of EXTENDED_KEYS) {
    const given = explicit?.[key];
    out[key] = isToken(given) ? given : EXTENDED_FALLBACK[key](core);
  }
  return out;
}

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

  // Core 8 are strict-validated above; extended 10 are filled by the single
  // promotion rule — explicit valid values win, missing/corrupt fall back. The
  // returned colors are always the full 18-key set (the output invariant).
  const coreColors: CoreColors = {
    bg: c.bg as string,
    fg: c.fg as string,
    accent: c.accent as string,
    link: c.link as string,
    surface: c.surface as string,
    border: c.border as string,
    muted: c.muted as string,
    highlightBg: c.highlightBg as string,
  };
  return {
    name: t.name,
    colors: { ...coreColors, ...promoteToExtended(coreColors, c) },
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
  // Resolve the extended 10 through the SAME promotion rule so a hand-built Theme
  // (e.g. a test's 8-key object) still emits every --hN-color var. The fallback
  // logic is NOT re-implemented here — it lives only in promoteToExtended.
  const ext = promoteToExtended(t.colors, t.colors);
  return {
    "--bg": t.colors.bg,
    "--fg": t.colors.fg,
    "--accent": t.colors.accent,
    "--link": t.colors.link,
    "--surface": t.colors.surface,
    "--border": t.colors.border,
    "--muted": t.colors.muted,
    "--highlight-bg": t.colors.highlightBg,
    "--h1-color": ext.h1,
    "--h2-color": ext.h2,
    "--h3-color": ext.h3,
    "--h4-color": ext.h4,
    "--h5-color": ext.h5,
    "--h6-color": ext.h6,
    "--bold-color": ext.bold,
    "--italic-color": ext.italic,
    "--code-color": ext.code,
    "--highlight-color": ext.highlight,
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
    // Extended 10 are written explicitly = exactly what promoteToExtended would
    // derive from this core palette (fg/muted/accent + the highlight ink), so
    // adopting the preset causes zero visual drift vs the current styles.css.
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
      },
      radii: { ...SHARED_RADII },
      font: { ...SHARED_FONT },
    };
  }
  if (name === "claude") {
    // The Claude editorial palette: tinted-cream canvas + warm-ink text, coral
    // reserved for action/link/code (the brand's "coral is scarce" rule). The 18
    // keys are written explicitly and mirror styles.css :root[data-theme="claude"]
    // byte-for-byte (the zero-drift invariant). NOTE: unlike dark/light, claude's
    // extended keys are NOT all what promoteToExtended would derive — headings are
    // ink (#141413), bold/italic/highlight are hand-tuned editorial tones — so the
    // explicit values are load-bearing, not a fallback echo. Body sans stays the
    // shared Inter stack; the serif HEADING is a styles.css-only --font-heading
    // token (not a schema field), so it isn't carried in the JSON theme.
    return {
      name: "claude",
      colors: {
        bg: "#faf9f5",
        fg: "#141413",
        accent: "#cc785c",
        link: "#a9583e",
        surface: "#efe9de",
        border: "#e6dfd8",
        muted: "#6c6a64",
        highlightBg: "#f0d9a8",
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
      },
      radii: { ...SHARED_RADII },
      font: { ...SHARED_FONT },
    };
  }
  return {
    name: "dark",
    colors: {
      bg: "#131110",
      fg: "#ffffff",
      accent: "#a8c8e8",
      link: "#a8c8e8",
      surface: "#1c1917",
      border: "rgba(255,255,255,.12)",
      muted: "#a8a29e",
      highlightBg: "#ffe066",
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
    },
    radii: { ...SHARED_RADII },
    font: { ...SHARED_FONT },
  };
}
