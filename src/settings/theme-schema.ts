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
    // Optional keys (2026-08 request: "배경색상도 정의할 수 있으면 좋겟어", then
    // 2026-08 round 2: "인용 배경색이라던지, 코드블럭이라던지, 빠진서식들이 더
    // 필요하고, 볼드이탤릭은 별도의 색상으로"). Unlike the extended text-color keys
    // above, these are optional on BOTH input AND output — `undefined` is a
    // first-class state, not a value to promote/fill. Historically all 11 of the
    // round-1 keys meant "no background" (transparent), so the class was named
    // BACKGROUND_KEYS; round 2 adds keys whose absence means "follow the theme's
    // derived/inherited value" (`initial`, not `transparent`) — boldItalic follows
    // whichever of bold/italic is the innermost nested span (direction-dependent,
    // see the boldItalic doc comment below), quote/codeBlock/strike inherit,
    // quoteBg/quoteBar/codeBlockBg follow the --block-fill/--block-edge
    // derivation. "background" no longer describes
    // the whole class, so it's OPTIONAL_KEYS now; absentKind(key) tells you which
    // of the two an absent key means. See OPTIONAL_KEYS/resolveOptional/absentKind.
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
    /** Bold+italic combined (`***x***`, or any bold nested in italic or vice
     *  versa) text color. Absent → follows whichever of --bold-color/
     *  --italic-color the CURRENTLY-RENDERED innermost span already used (real
     *  DOM is two NESTED spans — `.cm-em`+`.cm-strong` never coexist on one
     *  element — so there is no single fixed fallback; direction depends on
     *  which marker the user nested innermost: `***x***`/`_**x**_`/`*__x__*`
     *  nest strong-inside-em → bold wins, `**_x_**`/`__*x*__` nest
     *  em-inside-strong → italic wins. See styles.css `.cm-em .cm-strong` /
     *  `.cm-strong .cm-em` — the 2026-08 golden-master fix for the dead
     *  `.cm-strong.cm-em` compound selector, `_workspace/03_qa2_report.md`). */
    boldItalic?: string;
    /** Bold+italic combined background. Absent → same direction-dependent
     *  fallback as `boldItalic` (--bold-bg or --italic-bg, whichever the
     *  innermost span already used). */
    boldItalicBg?: string;
    /** `~~strike~~` text color. Absent → inherits the surrounding color (a strike
     *  can nest inside a heading/bold/quote; a fixed fallback would regress that
     *  nesting — see styles.css `.cm-strike`). */
    strike?: string;
    /** `~~strike~~` background. Absent → transparent (no prior background existed
     *  for strikethrough text, unlike codeBg's surface-veil precedent). */
    strikeBg?: string;
    /** Blockquote text color. Absent → inherits (same nesting reasoning as strike). */
    quote?: string;
    /** Blockquote background. Absent → follows the derived --block-fill (the
     *  theme-direction-reversal token: dark lightens, light darkens). A fixed
     *  fallback would freeze that direction — see resolveOptional/OPTIONAL_INTRINSIC. */
    quoteBg?: string;
    /** Blockquote left bar color. Absent → follows the derived --block-edge (the
     *  2026-08 round-1 audit's Major #3 — the bar previously had no key of its own
     *  and silently rode --border, a variable the real editor doesn't use for it). */
    quoteBar?: string;
    /** Fenced code BLOCK text color (distinct from `code`, which is inline code).
     *  Absent → inherits. */
    codeBlock?: string;
    /** Fenced code BLOCK background. Absent → follows the derived --block-fill
     *  (same direction-preserving reasoning as quoteBg). */
    codeBlockBg?: string;
    /** ```highlight markdown-block background (distinct from inline `highlightBg`,
     *  which is the saturated ==mark== fluorescent tone — this is a full-width
     *  line fill, toned well below it). Absent → follows the derived
     *  `color-mix(in srgb, var(--highlight-bg) 22%, transparent)` formula
     *  (round 2 request: "```highlight 블록만 테마 대상에서 빠졌다" — same OPTIONAL_KEYS
     *  "auto" family as quoteBg/codeBlockBg, so an unconfigured theme is
     *  byte-identical to the pre-this-feature derived tone). The derivation
     *  formula's SSOT stays in styles.css's fallback literal (theme-schema never
     *  re-derives it) — see resolveOptional/OPTIONAL_INTRINSIC. */
    highlightBlockBg?: string;
  };
  /** --radius-md/lg/xl. (No --radius-sm: styles.css only fallback-references it.) */
  radii: { md: string; lg: string; xl: string };
  /** --font-sans (a CSS font stack). */
  font: { sans: string };
  /** Block-element geometry, shared by code block / blockquote / highlight block
   *  (the --block-fill "one surface family" rule, applied to shape). Optional on
   *  BOTH sides like OPTIONAL_KEYS — absence is first-class and means "each
   *  element keeps its current hardcoded geometry" (auto). Extension path: a
   *  future per-element override slots its own var IN FRONT of the shared var in
   *  the CSS chain (`var(--codeblock-radius, var(--block-radius, <fallback>))`)
   *  — no key rename needed. Kept OUT of `colors` on purpose (a length value
   *  under `colors` would be a naming lie, and the OPTIONAL_KEYS machinery is
   *  typed to `Theme["colors"]`) — see GEOMETRY_KEYS/GEOMETRY_INTRINSIC/
   *  resolveGeometry, the small mirror of the OPTIONAL_KEYS mechanism for this
   *  one extra field. Absent geometry section entirely (both keys unset)
   *  serializes without a `geometry` key at all (see parseTheme) so a legacy
   *  theme JSON round-trips byte-identical. */
  geometry?: {
    /** Outer corner radius, ONE CSS length token (see `isSingleToken` —
     *  a multi-token shorthand like `.5em 1em` is treated as absent, since
     *  `.cm-blockquote-first`'s single-corner properties would reject it at
     *  computed-value time). Absent → per-element current value (codeBlock:
     *  var(--radius-md); blockquote: 0; highlightBlock: var(--radius-sm, 6px)). */
    blockRadius?: string;
    /** Inner padding, ONE CSS length token (same single-token rule as
     *  blockRadius — a 2-value shorthand would collapse blockquote's
     *  single-property `padding-left` to invalid/unset). Absent → per-element
     *  current value (codeBlock: .7em/.9em; blockquote: left .75em only;
     *  highlightBlock: none). */
    blockPadding?: string;
  };
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

/** The 21 OPTIONAL keys (2026-08 round 1: 11 background keys; round 2: +9 more —
 *  boldItalic(Bg), strike(Bg), quote/quoteBg/quoteBar, codeBlock(Bg); a later
 *  round adds +1 more — highlightBlockBg). Distinct
 *  class from EXTENDED_KEYS: extended keys are optional-in/always-filled-out
 *  (promote); optional keys are optional on BOTH sides — `undefined` is a
 *  first-class state that survives parse→serialize round-trips, not a hole to
 *  patch. fg has no background key by design (body background IS --bg; a
 *  separate fgBg would fork that concept into two SSOT sources). Renamed from
 *  BACKGROUND_KEYS (round 2): the round-1 11 keys all meant "no background" on
 *  absence, but boldItalic/strike/quote/codeBlock are TEXT colors that mean
 *  "inherit/derive" on absence, not "no background" — see absentKind. */
export const OPTIONAL_KEYS = [
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
  "boldItalic",
  "boldItalicBg",
  "strike",
  "strikeBg",
  "quote",
  "quoteBg",
  "quoteBar",
  "codeBlock",
  "codeBlockBg",
  "highlightBlockBg",
] as const;
export type OptionalKey = (typeof OPTIONAL_KEYS)[number];

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

/** "부재한 옵셔널 키가 무엇으로 방출되는가" — the ONE place that answers what an
 *  absent optional key paints as. Two families:
 *  - "none" family (round 1, 11 keys): genuinely transparent — that element had
 *    no background before backgrounds existed. codeBg is the one exception
 *    WITHIN this family: it resolves to the existing inline-code chip fill
 *    (--surface-veil) so "no background configured" reproduces the CURRENT chip
 *    exactly, not a regression to no-fill.
 *  - "auto" family (round 2, 9 keys): the CSS-wide keyword `initial`, chosen
 *    specifically because it makes the custom property guaranteed-invalid —
 *    that makes the consuming `var(--x, <fallback>)` rule in styles.css fall
 *    through to its fallback (the theme's derived/inherited value: --block-fill,
 *    --italic-color, `inherit`, …). This is NOT re-deriving that fallback value
 *    in TS (which would create a second source for --block-fill's color-mix
 *    formula) — it only clears the override so CSS's own cascade decides.
 *    strikeBg is the one exception WITHIN this family: it's a genuine "none"
 *    (no prior strikethrough background existed), so it emits "transparent" like
 *    the round-1 family despite being introduced in round 2.
 *  Pure data, consumed only through resolveOptional/absentKind. */
const OPTIONAL_INTRINSIC: Record<OptionalKey, string> = {
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
  boldItalic: "initial",
  boldItalicBg: "initial",
  strike: "initial",
  strikeBg: "transparent",
  quote: "initial",
  quoteBg: "initial",
  quoteBar: "initial",
  codeBlock: "initial",
  codeBlockBg: "initial",
  highlightBlockBg: "initial",
};

/** "부재한 옵셔널 키가 무엇으로 방출되는가" (pure query, renamed from
 *  resolveBackground — round 2 generalizes the class beyond backgrounds). `v` is
 *  the theme's stored value for `key` (`undefined` when the user never set one);
 *  the CSS var themeToVars emits always resolves through here so an unset key is
 *  zero-drift from its pre-this-feature visuals. */
export function resolveOptional(key: OptionalKey, v: string | undefined): string {
  return v ?? OPTIONAL_INTRINSIC[key];
}

/** "키 부재가 '없음'인가 '자동'인가" (pure query). Distinguishes the two families
 *  documented on OPTIONAL_INTRINSIC: "none" (genuinely transparent — the
 *  inspector shows a slash-circle "없음" chip) vs "auto" (follows a
 *  derived/inherited value — the inspector shows a text-pill "자동" chip). The
 *  test is structural (which intrinsic value the key resolves to), not a second
 *  hand-maintained list, so it can never drift from OPTIONAL_INTRINSIC. */
export function absentKind(key: OptionalKey): "none" | "auto" {
  return OPTIONAL_INTRINSIC[key] === "transparent" ? "none" : "auto";
}

/** "이 키는 부재를 표현할 수 있는가" (pure query) — replaces the old hand-maintained
 *  `bgOptional` flag on ThemeTarget (a second, driftable copy of this same fact).
 *  A core key (e.g. `highlightBg`) is NOT optional — it's strict-required, so the
 *  inspector shows no "없음"/"자동" chip for it at all. */
export function isOptionalKey(k: string): k is OptionalKey {
  return (OPTIONAL_KEYS as readonly string[]).includes(k);
}

// ---------------------------------------------------------------------------
// Block geometry (Theme.geometry?.blockRadius/blockPadding) — a small mirror
// of the OPTIONAL_KEYS machinery above (GEOMETRY_KEYS/GEOMETRY_INTRINSIC/
// resolveGeometry ↔ OPTIONAL_KEYS/OPTIONAL_INTRINSIC/resolveOptional), kept as
// its OWN pair of names rather than folded into the color machinery because
// its values are CSS lengths, not colors, and `Theme["colors"]`-typed
// OPTIONAL_KEYS can't hold a `geometry?.blockRadius` key without lying about
// what it stores.
// ---------------------------------------------------------------------------

export const GEOMETRY_KEYS = ["blockRadius", "blockPadding"] as const;
export type GeometryKey = (typeof GEOMETRY_KEYS)[number];

/** Both geometry keys are "auto" family (see OPTIONAL_INTRINSIC) — absence
 *  means "keep this element's own current hardcoded geometry", which is what
 *  `initial` (a guaranteed-invalid custom-property value) achieves: the
 *  consuming `var(--block-radius, <fallback>)` in styles.css falls through to
 *  its per-element fallback. */
const GEOMETRY_INTRINSIC: Record<GeometryKey, string> = {
  blockRadius: "initial",
  blockPadding: "initial",
};

/** Mirrors resolveOptional for the geometry pair. Pure query. */
export function resolveGeometry(key: GeometryKey, v: string | undefined): string {
  return v ?? GEOMETRY_INTRINSIC[key];
}

/** "이 값은 공백 없는 단일 토큰인가" (pure query) — a non-empty string with no
 *  internal whitespace. Named `isSingleToken`, NOT `isSingleLengthToken`
 *  (2026-08 감사 🟢 반영: the old name promised CSS-length validation that
 *  the implementation never did — `"red"` or `"foo"` pass just as readily as
 *  `"12px"` does): this is a whitespace check, nothing more. Named because it
 *  encodes one deliberate domain rule (design §3): a multi-token shorthand
 *  (`.5em 1em`, a 4-value radius shorthand) is accepted by `.cm-codeblock`'s
 *  own shorthand properties but collapses `.cm-blockquote`'s single-property
 *  `padding-left`/per-corner `border-*-radius` to an INVALID computed value —
 *  CSS then drops the whole declaration, silently un-setting it instead of
 *  falling back. Rejecting (treating as absent) any value containing
 *  whitespace closes that trap structurally, for BOTH keys, rather than
 *  validating "is this exactly one CSS length" (which would need a
 *  unit-aware parser this codebase doesn't have and doesn't need — a stray
 *  non-length single token still can't create the multi-property collapse
 *  this guards against, so under-validating here is deliberate, not lazy). */
export function isSingleToken(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && !/\s/.test(v.trim());
}

/** All new-generation color keys (comment + all 20 OPTIONAL_KEYS, round 1's 11 +
 *  round 2's 9) — used by upgradePristinePreset to detect "this raw JSON already
 *  knows about the new keys" (so it never re-runs the promotion, avoiding
 *  double-upgrade). Spreading OPTIONAL_KEYS means round 2's new keys are included
 *  automatically — this is the "정확성 필수" guard the round-2 plan calls out: a
 *  JSON with preset colors untouched + `quoteBg` set must NOT be misjudged
 *  pristine (which would silently destroy quoteBg on the next parse, the same
 *  failure class as the round-1 audit's blocker #2). */
const NEW_GEN_KEYS: readonly string[] = ["comment", ...OPTIONAL_KEYS];

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
 *  is false and it is returned unchanged — no double-upgrade. `rawHasGeometry`
 *  is the SAME (b)-class gate extended to `geometry` (design §3's function-
 *  #2 trap): `builtInTheme` never sets `geometry`, so upgrading a theme whose
 *  raw JSON already mentions a geometry key would return the fresh preset and
 *  silently drop that key on this parse's way out — checked on presence in the
 *  raw JSON alone (not validity), since even an invalid geometry value the
 *  caller will drop is still evidence the user touched this theme. Pure query,
 *  called once from parseTheme's tail. */
export function upgradePristinePreset(
  t: Theme,
  rawColorKeys: readonly string[],
  rawHasGeometry: boolean,
): Theme {
  if (t.name !== "dark" && t.name !== "light" && t.name !== "claude") return t;
  if (rawColorKeys.some((k) => NEW_GEN_KEYS.includes(k))) return t;
  if (rawHasGeometry) return t;
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
  // Optional keys are never rejected/promoted — an absent or corrupt one is just
  // left out of `colors` (undefined), which IS the "none"/"auto" state (see
  // absentKind for which of the two a given key means).
  const optional: Partial<Record<OptionalKey, string>> = {};
  for (const k of OPTIONAL_KEYS) if (isToken(c[k])) optional[k] = c[k] as string;

  // `geometry` is tolerant like the optional colors above: an invalid/absent
  // key is dropped silently, never a reject. Unlike `colors`, the WHOLE
  // section is omitted from the parsed Theme when both keys end up absent —
  // not left as `{}` — so `serializeTheme` (plain JSON.stringify, which drops
  // `undefined` fields but NOT an empty object) doesn't reintroduce a
  // `"geometry": {}` a legacy theme JSON never had (design §3's round-trip
  // byte-preservation rule).
  const rawGeometry = t.geometry;
  const hasRawGeometry =
    typeof rawGeometry === "object" &&
    rawGeometry !== null &&
    GEOMETRY_KEYS.some((k) => k in (rawGeometry as Record<string, unknown>));
  let geometry: Theme["geometry"];
  if (typeof rawGeometry === "object" && rawGeometry !== null) {
    const g = rawGeometry as Record<string, unknown>;
    const out: Partial<Record<GeometryKey, string>> = {};
    for (const k of GEOMETRY_KEYS) if (isSingleToken(g[k])) out[k] = g[k];
    if (out.blockRadius !== undefined || out.blockPadding !== undefined) geometry = out;
  }

  const parsed: Theme = {
    name: t.name,
    colors: { ...coreColors, ...promoteToExtended(coreColors, c), ...optional },
    radii: { md: r.md as string, lg: r.lg as string, xl: r.xl as string },
    font: { sans: (font as { sans: string }).sans },
    ...(geometry ? { geometry } : {}),
  };
  // Object.keys(c) is the RAW colors object as parsed from JSON (pre-promotion) —
  // exactly what upgradePristinePreset needs to detect "no new-gen key present".
  return upgradePristinePreset(parsed, Object.keys(c), hasRawGeometry);
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
    // Optional vars are ALWAYS emitted (never conditional) — themeVarsSink
    // overwrites the map but never deletes a stale key, so a conditional emit
    // would let a previous theme's value survive a switch to a theme with the
    // key unset. resolveOptional is the sole "what does absence mean" rule; it
    // is not re-implemented here.
    "--bold-bg": resolveOptional("boldBg", t.colors.boldBg),
    "--italic-bg": resolveOptional("italicBg", t.colors.italicBg),
    "--code-bg": resolveOptional("codeBg", t.colors.codeBg),
    "--link-bg": resolveOptional("linkBg", t.colors.linkBg),
    "--comment-bg": resolveOptional("commentBg", t.colors.commentBg),
    "--h1-bg": resolveOptional("h1Bg", t.colors.h1Bg),
    "--h2-bg": resolveOptional("h2Bg", t.colors.h2Bg),
    "--h3-bg": resolveOptional("h3Bg", t.colors.h3Bg),
    "--h4-bg": resolveOptional("h4Bg", t.colors.h4Bg),
    "--h5-bg": resolveOptional("h5Bg", t.colors.h5Bg),
    "--h6-bg": resolveOptional("h6Bg", t.colors.h6Bg),
    // Round 2 (2026-08): 9 new vars, same always-emit rule. Absent → "initial"
    // for every key EXCEPT strikeBg (→ "transparent") — see OPTIONAL_INTRINSIC.
    "--bold-italic-color": resolveOptional("boldItalic", t.colors.boldItalic),
    "--bold-italic-bg": resolveOptional("boldItalicBg", t.colors.boldItalicBg),
    "--strike-color": resolveOptional("strike", t.colors.strike),
    "--strike-bg": resolveOptional("strikeBg", t.colors.strikeBg),
    "--quote-color": resolveOptional("quote", t.colors.quote),
    "--quote-bg": resolveOptional("quoteBg", t.colors.quoteBg),
    "--quote-bar": resolveOptional("quoteBar", t.colors.quoteBar),
    "--codeblock-color": resolveOptional("codeBlock", t.colors.codeBlock),
    "--codeblock-bg": resolveOptional("codeBlockBg", t.colors.codeBlockBg),
    "--highlightblock-bg": resolveOptional("highlightBlockBg", t.colors.highlightBlockBg),
    "--radius-md": t.radii.md,
    "--radius-lg": t.radii.lg,
    "--radius-xl": t.radii.xl,
    "--font-sans": t.font.sans,
    // Block geometry (design §3): always-emit, same rule as every optional var
    // above — absent → "initial" via resolveGeometry, letting styles.css's own
    // var(--block-radius, <per-element fallback>) decide.
    "--block-radius": resolveGeometry("blockRadius", t.geometry?.blockRadius),
    "--block-padding": resolveGeometry("blockPadding", t.geometry?.blockPadding),
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
