import { applyTheme, applyFontScale } from "../theme";
import {
  themeSetting,
  themeJsonSetting,
  syncJsonToPreset,
  fontScaleSetting,
  webFontSetting,
  fontFamilySetting,
  effectiveReadingFont,
  fontSizeSetting,
  readingWidthSetting,
  lineHeightSetting,
  sidebarWidthSetting,
  headingRatioSetting,
  headingFontSetting,
  effectiveHeadingFont,
} from "./app";
import { themeVarsSink, cssVarSink, headingScaleSink, webFontSink, headingFontSink } from "./sinks";

/** Theme / typography / sidebar-width SSOT → DOM sinks, bound once at boot
 *  BEFORE the editor mounts (moved out of main.ts boot(), 2026-09-25). */
export function bindBootSettingSinks(): void {
  // Theme is the SSOT; bind the DOM sink first so the dataset is set before the
  // editor mounts (mermaid reads it on its lazy initial load) — and so it also
  // applies on the no-file / error screens main.ts renders.
  themeSetting.bind(applyTheme);
  // The theme JSON is the effective source: fan its token map onto documentElement
  // (inline vars beat :root[data-theme]). Bind here, before the editor mounts, so
  // the vars are on the DOM for the editor + the no-file/error screens — and so a
  // saved/custom theme applies on first paint with no flash.
  themeJsonSetting.bind(themeVarsSink());
  // Preset → JSON sync: when the preset (themeSetting) changes via a path that
  // does NOT go through loadPreset (the panel's preset segmented control writes
  // themeSetting only), overwrite the JSON theme with that preset's builtin so
  // the color pickers + visual editor track the preset in real time. The name
  // guard inside syncJsonToPreset makes the loadPreset path a no-op (no double
  // write) and preserves user edits when re-selecting the same preset.
  themeSetting.subscribe(syncJsonToPreset);
  // Body text scale is the SSOT too: bind the CSS-var sink here (same place,
  // same reason as theme) so the saved scale is on the DOM before the editor
  // mounts, and so it applies on the no-file / error screens main.ts renders.
  fontScaleSetting.bind(applyFontScale);
  // Typography sinks — one setting.bind(sink) line each, no hand fan-out. These
  // drive CSS vars composed in styles.css (--editor-font-size composes with
  // --font-scale; --measure caps the reading column as a % of the window
  // width; --line-height the leading).
  // --reading-font has a SINGLE writer: webFontSink. The web font (if any) and the
  // font-family select are composed by effectiveReadingFont into {family, stack}
  // and fed to that one sink, so the head <link> + the var never have two writers
  // racing. webFontSetting.bind does the boot-time first apply; fontFamily only
  // re-composes on change (subscribe), so they don't double-apply at boot.
  const applyReadingFont = webFontSink();
  const composeReadingFont = () =>
    applyReadingFont(effectiveReadingFont(webFontSetting.get(), fontFamilySetting.get()));
  webFontSetting.bind(composeReadingFont); // initial + on web-font change
  fontFamilySetting.subscribe(composeReadingFont); // re-compose when the select changes
  fontSizeSetting.bind(cssVarSink("--editor-font-size", (px: number) => `${px}px`));
  readingWidthSetting.bind(cssVarSink("--measure", (pct: number) => `${pct}%`));
  lineHeightSetting.bind(cssVarSink("--line-height"));
  // Left sidebar width (drag sash): same setting.bind(cssVarSink) shape as the
  // typography vars above. The sash (created in main.ts, once `workspace` exists) previews
  // the width as a transient var during drag and commits here on release; this
  // sink re-applies that same value, so SSOT and the var converge (idempotent).
  sidebarWidthSetting.bind(cssVarSink("--sidebar-width", (px: number) => `${px}px`));
  // Heading typescale: one ratio → six --hN-scale vars (headingScaleSink fans
  // them; styles.css multiplies each into its line's font-size calc).
  headingRatioSetting.bind(headingScaleSink());
  // Heading font: "" defers to the theme (removes the inline var, letting
  // claude's Georgia or --reading-font show through); a choice overrides it.
  const applyHeadingFont = headingFontSink();
  headingFontSetting.bind((v) => applyHeadingFont(effectiveHeadingFont(v)));
}
