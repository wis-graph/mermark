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
    /** Aside/comment text tone, independent from --muted (2026-08 request: "주석도
     *  옅은색하라니까 검정색이랑 구분이 안되네" — muted was too dark AND un-tunable
     *  on its own). Optional for the same legacy-compat reason as the other extended
     *  keys; EXTENDED_FALLBACK.comment derives it from muted when absent. */
    comment?: string;
    // Background keys (2026-08 request: "배경색상도 정의할 수 있으면 좋겟어"). Unlike
    // the extended text-color keys above, these are optional on BOTH input AND
    // output — `undefined` is a first-class "no background" state, not a value to
    // promote/fill. See BACKGROUND_KEYS/resolveBackground for the full contract.
    boldBg?: string;
    italicBg?: string;
    codeBg?: string;
    linkBg?: string;
    commentBg?: string;
    h1Bg?: string;
    h2Bg?: string;
    h3Bg?: string;
    h4Bg?: string;
    h5Bg?: string;
    h6Bg?: string;
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
  "comment",
] as const;
export type ExtendedKey = (typeof EXTENDED_KEYS)[number];

/** The 11 BACKGROUND keys (2026-08 request). Distinct class from EXTENDED_KEYS:
 *  extended keys are optional-in/always-filled-out (promote); background keys are
 *  optional on BOTH sides — `undefined` ("no background") is a state that survives
 *  parse→serialize round-trips, not a hole to patch. fg has no background key by
 *  design (body background IS --bg; a separate fgBg would fork that concept into
 *  two SSOT sources). */
export const BACKGROUND_KEYS = [
  "boldBg",
  "italicBg",
  "codeBg",
  "linkBg",
  "commentBg",
  "h1Bg",
  "h2Bg",
  "h3Bg",
  "h4Bg",
  "h5Bg",
  "h6Bg",
] as const;
export type BackgroundKey = (typeof BACKGROUND_KEYS)[number];

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
  // Falls back to muted, not fg — comment is the SAME "quiet aside" role muted
  // played before this key existed (styles.css .cm-comment used --muted verbatim),
  // so an old theme with no comment key renders byte-identical to today.
  comment: (c) => c.muted,
};

/** "배경 없음이 무엇으로 렌더되는가" — the ONE place that answers what an absent
 *  background key paints as. codeBg intrinsically resolves to the existing inline-
 *  code chip fill (--surface-veil) so "no background configured" reproduces the
 *  CURRENT chip exactly, not a regression to no-fill; every other key's absence is
 *  genuinely transparent (that element had no background before this feature).
 *  Pure data, consumed only through resolveBackground. */
const BACKGROUND_INTRINSIC: Record<BackgroundKey, string> = {
  boldBg: "transparent",
  italicBg: "transparent",
  codeBg: "var(--surface-veil)",
  linkBg: "transparent",
  commentBg: "transparent",
  h1Bg: "transparent",
  h2Bg: "transparent",
  h3Bg: "transparent",
  h4Bg: "transparent",
  h5Bg: "transparent",
  h6Bg: "transparent",
};

/** "배경 없음이 무엇으로 렌더되는가" (pure query). `v` is the theme's stored value
 *  for `key` (`undefined` when the user never set one); the CSS var themeToVars
 *  emits always resolves through here so a "no background" theme is zero-drift
 *  from the pre-background-feature visuals. */
export function resolveBackground(key: BackgroundKey, v: string | undefined): string {
  return v ?? BACKGROUND_INTRINSIC[key];
}

/** All new-generation color keys (comment + the 11 backgrounds) — used by
 *  upgradePristinePreset to detect "this raw JSON already knows about the new
 *  keys" (so it never re-runs the promotion, avoiding double-upgrade). */
const NEW_GEN_KEYS: readonly string[] = ["comment", ...BACKGROUND_KEYS];

/** The pre-2026-08 18 keys (core 8 + the original 10 extended, i.e. EXTENDED_KEYS
 *  minus the newly-added `comment`). upgradePristinePreset compares exactly this
 *  set against a built-in preset's current values to decide "untouched by the
 *  user". */
const LEGACY_EXTENDED_KEYS = EXTENDED_KEYS.filter((k) => k !== "comment");

/** "손대지 않은 프리셋만 새 기본값(comment 등)으로 승격" — a saved theme is
 *  upgraded to the fresh builtInTheme(name) IFF: (a) its name is a built-in preset
 *  name, (b) the raw JSON it was parsed from mentions none of the new-generation
 *  keys yet, and (c) EVERY field the promotion would overwrite — the legacy 18
 *  core+extended colors, AND radii.md/lg/xl, AND font.sans — is byte-identical to
 *  that preset's current builtInTheme (nothing the user edited, anywhere in the
 *  theme). The name's promise is "untouched", not "untouched in colors only": a
 *  saved theme whose radii/font were hand-edited via the JSON accordion (colors
 *  left alone) must fail (c) too, or upgrading would silently discard that edit —
 *  the 2026-08 audit's blocker #2. Any custom edit — even one changed character in
 *  ANY of these fields, or a name the user renamed — takes the untouched branch
 *  and is returned as-is, so a customized theme is never silently overwritten.
 *  Idempotent: once a theme carries a new-gen key (e.g. from a prior upgrade), (b)
 *  is false and it is returned unchanged — no double-upgrade. Pure query, called
 *  once from parseTheme's tail. */
export function upgradePristinePreset(t: Theme, rawColorKeys: readonly string[]): Theme {
  if (t.name !== "dark" && t.name !== "light" && t.name !== "claude") return t;
  if (rawColorKeys.some((k) => NEW_GEN_KEYS.includes(k))) return t;
  const preset = builtInTheme(t.name);
  const legacyColorKeys: readonly (keyof Theme["colors"])[] = [...COLOR_KEYS, ...LEGACY_EXTENDED_KEYS];
  const colorsUnchanged = legacyColorKeys.every((k) => t.colors[k] === preset.colors[k]);
  const radiiUnchanged = RADII_KEYS.every((k) => t.radii[k] === preset.radii[k]);
  const fontUnchanged = t.font.sans === preset.font.sans;
  return colorsUnchanged && radiiUnchanged && fontUnchanged ? preset : t;
}

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
  // Background keys are never rejected/promoted — an absent or corrupt one is
  // just left out of `colors` (undefined), which IS the "no background" state.
  const backgrounds: Partial<Record<BackgroundKey, string>> = {};
  for (const k of BACKGROUND_KEYS) if (isToken(c[k])) backgrounds[k] = c[k] as string;

  const parsed: Theme = {
    name: t.name,
    colors: { ...coreColors, ...promoteToExtended(coreColors, c), ...backgrounds },
    radii: { md: r.md as string, lg: r.lg as string, xl: r.xl as string },
    font: { sans: (font as { sans: string }).sans },
  };
  // Object.keys(c) is the RAW colors object as parsed from JSON (pre-promotion) —
  // exactly what upgradePristinePreset needs to detect "no new-gen key present".
  return upgradePristinePreset(parsed, Object.keys(c));
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
    "--comment-color": ext.comment,
    // Background vars are ALWAYS emitted (never conditional) — themeVarsSink
    // overwrites the map but never deletes a stale key, so a conditional emit
    // would let a previous theme's background var survive a switch to a theme
    // with no background set. resolveBackground is the sole "no background"
    // rule; it is not re-implemented here.
    "--bold-bg": resolveBackground("boldBg", t.colors.boldBg),
    "--italic-bg": resolveBackground("italicBg", t.colors.italicBg),
    "--code-bg": resolveBackground("codeBg", t.colors.codeBg),
    "--link-bg": resolveBackground("linkBg", t.colors.linkBg),
    "--comment-bg": resolveBackground("commentBg", t.colors.commentBg),
    "--h1-bg": resolveBackground("h1Bg", t.colors.h1Bg),
    "--h2-bg": resolveBackground("h2Bg", t.colors.h2Bg),
    "--h3-bg": resolveBackground("h3Bg", t.colors.h3Bg),
    "--h4-bg": resolveBackground("h4Bg", t.colors.h4Bg),
    "--h5-bg": resolveBackground("h5Bg", t.colors.h5Bg),
    "--h6-bg": resolveBackground("h6Bg", t.colors.h6Bg),
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
        // comment: 0.7 the darkness step of --muted (#777169) on this canvas, so it
        // reads as clearly lighter than fg AND clearly distinguishable from muted —
        // 3.2:1 on bg, 5.7:1 from fg (see _workspace/01_ui_design.md 결정 5).
        comment: "#8f887e",
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
        // comment: 3.5:1 on the cream canvas, 5.1:1 from ink (결정 5) — warm-stone,
        // consistent with the editorial palette's other muted tones.
        comment: "#8c857a",
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
      // comment: 3.3:1 on the near-black canvas, 5.7:1 from --fg (결정 5) — one
      // deliberate notch quieter than --muted's 7.5:1 so it reads as an aside.
      comment: "#6b665f",
    },
    radii: { ...SHARED_RADII },
    font: { ...SHARED_FONT },
  };
}
