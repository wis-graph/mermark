// The SSOT registry: every user preference declared in one place. Sinks
// subscribe (in main.ts); writers call setting.set(). Adding a preference is a
// one-line declaration here plus subscriptions at the composition root.
import { defineSetting } from "./store";
import { systemTheme, type Theme } from "../theme";
import type { PreviewMode } from "../markdown/live-preview";

/** light/dark. Saved preference wins; otherwise the OS theme. */
export const themeSetting = defineSetting<Theme>({
  key: "mermark.theme",
  default: systemTheme(),
  parse: (raw) => (raw === "light" || raw === "dark" ? raw : null),
});

/** edit (live preview) / read (fixed render). Defaults to read. */
export const modeSetting = defineSetting<PreviewMode>({
  key: "mermark.mode",
  default: "read",
  parse: (raw) => (raw === "edit" || raw === "read" ? raw : null),
});

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
