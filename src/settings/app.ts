// The SSOT registry: every user preference declared in one place. Sinks
// subscribe (in main.ts); writers call setting.set(). Adding a preference is a
// one-line declaration here plus a subscription at the composition root. Panel
// preferences use registerSetting (so they render); SSOT-only ones (mode,
// fontScale) use defineSetting (no ui).
import { defineSetting } from "./store";
import { registerSetting } from "./registry";
import { systemTheme, type Theme } from "../theme";
import { builtInTheme, parseTheme, serializeTheme, type Theme as ThemeJson, type PresetName } from "./theme-schema";
import type { PreviewMode } from "../markdown/live-preview";

const numberParse = (raw: string | null): number | null => {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

// ── 테마 (Theme) ────────────────────────────────────────────────────────────

/** light/dark preset picker. Saved preference wins; otherwise the OS theme.
 *  Migrated to the registry so it renders in the panel's 테마 category. */
export const themeSetting = registerSetting<Theme>({
  key: "mermark.theme",
  default: systemTheme(),
  parse: (raw) => (raw === "light" || raw === "dark" ? raw : null),
  ui: {
    label: "프리셋",
    group: "테마",
    control: {
      kind: "segmented",
      options: [
        { value: "dark", label: "다크" },
        { value: "light", label: "라이트" },
      ],
    },
  },
});

/** The active theme as ONE editable JSON document (the headline feature). The
 *  JSON is the effective source: themeVarsSink fans its vars onto documentElement
 *  (inline, beating :root[data-theme]). parseTheme is the import-validation rule;
 *  a corrupt saved/pasted value → null → default. */
export const themeJsonSetting = registerSetting<ThemeJson>({
  key: "mermark.themeJson",
  default: builtInTheme(systemTheme()),
  parse: parseTheme,
  serialize: serializeTheme,
  ui: { label: "테마 JSON", group: "테마", control: { kind: "json" } },
});

/** Load a built-in preset: write BOTH settings in one place so they stay
 *  coherent — themeJsonSetting (the effective vars) AND themeSetting (the
 *  data-theme flip + mermaid re-bake trigger). Command/CQS: void. */
export function loadPreset(name: PresetName): void {
  themeJsonSetting.set(builtInTheme(name));
  themeSetting.set(name);
}

/** Sync the JSON theme to a preset that was just selected (e.g. via the panel's
 *  preset segmented control, which writes themeSetting WITHOUT going through
 *  loadPreset). The name guard is the loop breaker AND the edit-preserver: it is
 *  checked BEFORE .set, so (a) re-selecting the same preset never overwrites the
 *  user's custom edits, and (b) loadPreset's own themeSetting write — fired right
 *  after it already set themeJson to the matching name — is a no-op here (no
 *  recursion, no double write). Command/CQS: void. Order is load-bearing: compare
 *  name first, set only on mismatch. */
export function syncJsonToPreset(name: PresetName): void {
  if (themeJsonSetting.get().name !== name) themeJsonSetting.set(builtInTheme(name));
}

// ── 타이포그래피 (Typography) ─────────────────────────────────────────────────

// The Inter stack is BOTH a select option and the default — pinned by name (not
// FONT_STACKS[0]) so adding the Pretendard option below can't silently flip the
// default and regress a no-preference user's visuals (DESIGN: Pretendard is
// opt-in only).
const INTER_STACK = '"Inter", system-ui, sans-serif';

const FONT_STACKS = [
  // Pretendard (bundled woff2): a Korean+Latin sans whose stack ends in system-ui
  // so glyphs outside the bundled face fall back silently. Opt-in via the select.
  { value: '"Pretendard Variable", Pretendard, system-ui, sans-serif', label: "Pretendard (Sans · 한글)" },
  { value: INTER_STACK, label: "Inter (Sans)" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia (Serif)" },
  { value: "ui-monospace, monospace", label: "Monospace" },
];

/** Font family for the reading column. A CSS font stack. Default pinned to Inter
 *  (not FONT_STACKS[0]) so the Pretendard option never shifts the no-preference
 *  default — Pretendard is opt-in. The web font (webFontSetting) layers on top of
 *  this via effectiveReadingFont; this stack is the fallback. */
export const fontFamilySetting = registerSetting<string>({
  key: "mermark.fontFamily",
  default: INTER_STACK,
  parse: (raw) => (raw == null ? null : raw),
  ui: { label: "글꼴", group: "타이포그래피", control: { kind: "select", options: FONT_STACKS } },
});

/** User-typed Google Fonts family name. Empty = no web font (the prior behavior);
 *  a non-empty value loads fonts.googleapis.com and takes over --reading-font (with
 *  the select stack kept as fallback). The store keeps the raw string the user
 *  typed; sanitization happens at the URL-build step (googleFontHref), not here. */
export const webFontSetting = registerSetting<string>({
  key: "mermark.webFont",
  default: "",
  parse: (raw) => (raw == null ? null : raw),
  ui: {
    label: "웹폰트 (Google Fonts)",
    group: "타이포그래피",
    control: { kind: "text", placeholder: "예: Noto Sans KR", help: "Google Fonts 패밀리 이름. 비우면 사용 안 함." },
  },
});

// fonts.googleapis.com is hardcoded here — a user-typed family can NEVER change
// the origin, so the fetched host is forever exactly what the CSP allowlists.
const GOOGLE_FONTS_ORIGIN = "https://fonts.googleapis.com";
// Google family names are letters/digits with internal spaces and hyphens. The
// allowlist must begin with an alnum, so a leading space/hyphen can't start an
// injection. Everything else (quotes, CRLF, ?, &, :, /, %, <, >) is rejected.
const GOOGLE_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;

/** Build a Google Fonts CSS2 stylesheet URL for a user-typed family, or null if
 *  the family is empty/invalid. The injection allowlist rule lives in ONE named
 *  place: only [A-Za-z0-9], space, and hyphen survive, so no attacker can graft a
 *  second query param, a CRLF header split, or an arbitrary origin onto the URL.
 *  The origin is a hardcoded literal (user input can't move it). CQS: query, pure. */
export function googleFontHref(family: string): string | null {
  const trimmed = family.trim();
  if (trimmed === "") return null; // empty → off
  if (!GOOGLE_FAMILY_RE.test(trimmed)) return null; // injection gate
  const enc = encodeURIComponent(trimmed); // "Noto Sans KR" → "Noto%20Sans%20KR"
  return `${GOOGLE_FONTS_ORIGIN}/css2?family=${enc}&display=swap`;
}

/** The reading-font precedence rule in ONE named place: a non-empty web font wins
 *  and is PREPENDED to the chosen select stack (so the local stack stays the
 *  fallback if the web font fails/offline); an empty web font yields the select
 *  stack as-is. Returns {family, stack} for webFontSink. CQS: query, pure. */
export function effectiveReadingFont(webFont: string, stack: string): { family: string; stack: string } {
  const f = webFont.trim();
  if (f === "") return { family: "", stack }; // no web font → select stack
  return { family: f, stack: `"${f}", ${stack}` }; // web font first, stack fallback
}

/** Base body text size in px → --editor-font-size. Distinct from fontScale (the
 *  transient ⌘± multiplier); styles.css composes them via calc(). Default 16 =
 *  1rem to preserve current visuals. */
export const fontSizeSetting = registerSetting<number>({
  key: "mermark.fontSize",
  default: 16,
  parse: numberParse,
  ui: { label: "본문 크기", group: "타이포그래피", control: { kind: "slider", min: 12, max: 24, step: 1, unit: "px" } },
});

const READING_WIDTH_MIN_CH = 40; // gradable lower bound (~too narrow below this)
const READING_WIDTH_MAX_CH = 90; // gradable upper bound (Butterick: lines get too long past ~75–90)
const READING_WIDTH_DEFAULT_CH = 68; // Butterick/iA Writer measure (45–75 char range)

/** The "valid reading measure (ch)" rule (40–90ch) in one named place. parse and
 *  the slider bounds both honor it, so the clamp rule lives once (SSOT) — never
 *  inline Math.min/max scattered around. Same pattern as clampFontScale.
 *  Doubles as the px→ch migration: a px-era saved value (e.g. 820) clamps to the
 *  90ch ceiling, monotonically preserving the user's "wide" intent without a
 *  version flag or a px→ch conversion heuristic. CQS: query, pure. */
export function clampReadingWidth(n: number): number {
  return Math.min(READING_WIDTH_MAX_CH, Math.max(READING_WIDTH_MIN_CH, n));
}

/** Reading column width in ch → --measure (default 68ch; styles.css caps it with
 *  min(var(--measure), 100%) so a wide ch never overflows a narrow viewport). */
export const readingWidthSetting = registerSetting<number>({
  key: "mermark.readingWidth",
  default: READING_WIDTH_DEFAULT_CH,
  parse: (raw) => {
    const n = numberParse(raw);
    return n == null ? null : clampReadingWidth(n); // corrupt → default; px-era value → clamp
  },
  ui: {
    label: "본문 너비",
    group: "타이포그래피",
    control: { kind: "slider", min: READING_WIDTH_MIN_CH, max: READING_WIDTH_MAX_CH, step: 1, unit: "ch" },
  },
});

/** Body line-height → --line-height (default 1.6, the current value). */
export const lineHeightSetting = registerSetting<number>({
  key: "mermark.lineHeight",
  default: 1.6,
  parse: numberParse,
  ui: { label: "줄 간격", group: "타이포그래피", control: { kind: "slider", min: 1.2, max: 2.0, step: 0.1 } },
});

/** Heading typescale ratio (select). Declared in round 1; sink deferred. */
export const headingRatioSetting = registerSetting<string>({
  key: "mermark.headingRatio",
  default: "1.25",
  parse: (raw) => (raw === "1.2" || raw === "1.25" || raw === "1.333" ? raw : null),
  ui: {
    label: "제목 비율",
    group: "타이포그래피",
    control: {
      kind: "select",
      options: [
        { value: "1.2", label: "1.2 (Minor third)" },
        { value: "1.25", label: "1.25 (Major third)" },
        { value: "1.333", label: "1.333 (Perfect fourth)" },
      ],
    },
  },
});

// ── 에디터 (Editor / Behavior) — declared + rendered; sinks stubbed in round 1 ──

/** edit (live preview) / read (fixed render). Defaults to read. The LIVE value,
 *  toggled by ⌘E in the status bar — stays defineSetting (no panel ui). */
export const modeSetting = defineSetting<PreviewMode>({
  key: "mermark.mode",
  default: "read",
  parse: (raw) => (raw === "edit" || raw === "read" ? raw : null),
});

/** The boot default mode (panel preference). Distinct from modeSetting (the live
 *  ⌘E value). Round 1: declared + rendered; boot wiring deferred. */
export const defaultModeSetting = registerSetting<PreviewMode>({
  key: "mermark.defaultMode",
  default: "read",
  parse: (raw) => (raw === "edit" || raw === "read" ? raw : null),
  ui: {
    label: "기본 모드",
    group: "에디터",
    control: {
      kind: "segmented",
      options: [
        { value: "read", label: "리더" },
        { value: "edit", label: "편집" },
      ],
    },
  },
});

/** Seed the live session mode from the boot default before the editor reads its
 *  initial mode. defaultMode is the boot-mode source (panel preference);
 *  modeSetting is the live ⌘E toggle value. Calling this at boot makes the app
 *  start in the user's chosen default, after which ⌘E only moves modeSetting —
 *  the default is re-applied on the next boot. Named so boot doesn't inline-mix
 *  the two settings. Command/CQS: void. */
export function seedSessionMode(): void {
  modeSetting.set(defaultModeSetting.get());
}

/** Autosave debounce in ms. Default 200ms — autosave runs invisibly on a brief
 *  typing pause (Obsidian-style), so the manual save button is gone. The slider
 *  floor is already 200ms (the SSOT for "fast but not per-keystroke"). */
export const autosaveDelaySetting = registerSetting<number>({
  key: "mermark.autosaveDelay",
  default: 200,
  parse: numberParse,
  ui: { label: "자동 저장 지연", group: "에디터", control: { kind: "slider", min: 200, max: 3000, step: 100, unit: "ms" } },
});

export type ConflictPolicy = "pause" | "overwrite";
/** On an external-change conflict: pause autosave (current behavior) or
 *  overwrite. Round 1: declared + rendered; sink deferred. */
export const conflictPolicySetting = registerSetting<ConflictPolicy>({
  key: "mermark.conflictPolicy",
  default: "pause",
  parse: (raw) => (raw === "pause" || raw === "overwrite" ? raw : null),
  ui: {
    label: "충돌 정책",
    group: "에디터",
    control: {
      kind: "segmented",
      options: [
        { value: "pause", label: "중단" },
        { value: "overwrite", label: "덮어쓰기" },
      ],
    },
  },
});

export type VimMode = "on" | "off";
/** Enable or disable Vim emulation mode. */
export const vimModeSetting = registerSetting<VimMode>({
  key: "mermark.vimMode",
  default: "off",
  parse: (raw) => (raw === "on" || raw === "off" ? raw : null),
  ui: {
    label: "Vim 모드",
    group: "에디터",
    control: {
      kind: "segmented",
      options: [
        { value: "on", label: "켜기" },
        { value: "off", label: "끄기" },
      ],
    },
  },
});

// ── Mermaid (plugin-registered category) ─────────────────────────────────────

export type PanZoom = "on" | "off";
/** Pan/zoom interaction on mermaid diagrams. Read in attachPanZoom (round-1 sink). */
export const panZoomSetting = registerSetting<PanZoom>({
  key: "mermark.panZoom",
  default: "on",
  parse: (raw) => (raw === "on" || raw === "off" ? raw : null),
  ui: {
    label: "팬/줌",
    group: "Mermaid",
    control: {
      kind: "segmented",
      options: [
        { value: "on", label: "켜기" },
        { value: "off", label: "끄기" },
      ],
    },
  },
});

export type ThemeForce = "follow" | "dark" | "light";
/** Force mermaid's diagram theme or follow the app theme. Round 1: declared +
 *  rendered; sink deferred (self-subscription is a later step). */
export const themeForceSetting = registerSetting<ThemeForce>({
  key: "mermark.themeForce",
  default: "follow",
  parse: (raw) => (raw === "follow" || raw === "dark" || raw === "light" ? raw : null),
  ui: {
    label: "다이어그램 테마",
    group: "Mermaid",
    control: {
      kind: "segmented",
      options: [
        { value: "follow", label: "앱 따라감" },
        { value: "dark", label: "항상 다크" },
        { value: "light", label: "항상 라이트" },
      ],
    },
  },
});

// ── 플러그인 (Plugins) — placeholder; empty in round 1 ────────────────────────

/** Placeholder so the Plugins category appears. Any future feature that calls
 *  registerSetting with ui.group "플러그인" renders here automatically. */
registerSetting<null>({
  key: "mermark.pluginsPlaceholder",
  default: null,
  parse: () => null,
  serialize: () => "",
  ui: { label: "플러그인", group: "플러그인", control: { kind: "info" } },
});

// ── Body text zoom (fontScale, ⌘±) — SSOT-only, no panel ui ───────────────────

const FONT_SCALE_MIN = 0.8;
const FONT_SCALE_MAX = 2.0;
const FONT_SCALE_STEP = 0.1;
const FONT_SCALE_DEFAULT = 1.0;

/** The "valid body-text scale" rule (0.8–2.0, snapped to the 0.1 zoom step) in
 *  one named place. Both parse and the zoom commands route through it, so the
 *  clamp/step rule lives once (SSOT) instead of inline Math.min/max scattered
 *  across handlers. Rounds first to kill float drift (0.1+0.2 = 0.30000…). */
export function clampFontScale(n: number): number {
  const stepped = Math.round(n / FONT_SCALE_STEP) * FONT_SCALE_STEP;
  const snapped = Math.round(stepped * 10) / 10; // normalize to one decimal
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, snapped));
}

/** Body (.cm-content) text scale. SSOT + persisted, like theme/mode. The CSS
 *  var sink (applyFontScale) binds to this in main.ts. */
export const fontScaleSetting = defineSetting<number>({
  key: "mermark.fontScale",
  default: FONT_SCALE_DEFAULT,
  parse: (raw) => {
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? clampFontScale(n) : null; // corrupt/out-of-range → clamp or default
  },
  serialize: (v) => String(v),
});

// Named zoom commands (CQS: void, single SSOT writer = fontScaleSetting.set).
// The key handler in main.ts calls these by intent rather than inlining the
// step/clamp math at the keydown site.
export function zoomIn(): void {
  fontScaleSetting.set(clampFontScale(fontScaleSetting.get() + FONT_SCALE_STEP));
}
export function zoomOut(): void {
  fontScaleSetting.set(clampFontScale(fontScaleSetting.get() - FONT_SCALE_STEP));
}
export function resetZoom(): void {
  fontScaleSetting.set(FONT_SCALE_DEFAULT);
}
