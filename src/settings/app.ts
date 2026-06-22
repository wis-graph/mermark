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

// ── 타이포그래피 (Typography) ─────────────────────────────────────────────────

const FONT_STACKS = [
  { value: '"Inter", system-ui, sans-serif', label: "Inter (Sans)" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia (Serif)" },
  { value: "ui-monospace, monospace", label: "Monospace" },
];

/** Font family for the reading column. A CSS font stack (no web-font download). */
export const fontFamilySetting = registerSetting<string>({
  key: "mermark.fontFamily",
  default: FONT_STACKS[0].value,
  parse: (raw) => (raw == null ? null : raw),
  ui: { label: "글꼴", group: "타이포그래피", control: { kind: "select", options: FONT_STACKS } },
});

/** Base body text size in px → --editor-font-size. Distinct from fontScale (the
 *  transient ⌘± multiplier); styles.css composes them via calc(). Default 16 =
 *  1rem to preserve current visuals. */
export const fontSizeSetting = registerSetting<number>({
  key: "mermark.fontSize",
  default: 16,
  parse: numberParse,
  ui: { label: "본문 크기", group: "타이포그래피", control: { kind: "slider", min: 12, max: 24, step: 1, unit: "px" } },
});

/** Reading column width in px → --measure (default 820, the current cap). */
export const readingWidthSetting = registerSetting<number>({
  key: "mermark.readingWidth",
  default: 820,
  parse: numberParse,
  ui: { label: "본문 너비", group: "타이포그래피", control: { kind: "slider", min: 560, max: 1100, step: 20, unit: "px" } },
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

/** Autosave debounce in ms. Round 1: declared + rendered; sink deferred. */
export const autosaveDelaySetting = registerSetting<number>({
  key: "mermark.autosaveDelay",
  default: 800,
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

// ── Mermaid (plugin-registered category) ─────────────────────────────────────

export type PanZoom = "on" | "off";
/** Pan/zoom interaction on mermaid diagrams. Read in initPanZoom (round-1 sink). */
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
