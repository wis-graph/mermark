// CSS-var sinks: the command side of the SSOT. A setting is the single writer;
// these sinks subscribe and fan the value onto documentElement. No setting is
// read here — the value arrives as the argument (main.ts binds setting → sink).
import { applyThemeVars } from "../theme";
import { themeToVars, type Theme } from "./theme-schema";

/** The theme sink: fan a whole token map onto documentElement in one place
 *  (themeJsonSetting.bind(themeVarsSink())). One sink fanning a map — never N
 *  scattered setProperty calls. Command/CQS: returns void. */
export function themeVarsSink(): (t: Theme) => void {
  return (t) => applyThemeVars(themeToVars(t));
}

/** A single-var sink for the typography sliders/selects: write `value` (or
 *  format(value)) to one CSS var on documentElement. `format` lets a numeric
 *  setting carry a unit (e.g. px → "16px") while the SSOT keeps the raw number.
 *  Command/CQS: returns void. */
export function cssVarSink<T>(varName: string, format?: (v: T) => string): (v: T) => void {
  return (v) => document.documentElement.style.setProperty(varName, format ? format(v) : String(v));
}

/** The heading typescale rule in one named place: a ratio → six per-level
 *  scale factors [h1..h6]. CSS calc can't raise a var to a power (and `pow()`
 *  isn't reliably supported), so the powers are computed here in JS and fanned
 *  as six vars by headingScaleSink. h1=ratio³ … h4=√ratio so smaller ratios
 *  monotonically flatten the contrast; h5 pins to body size, h6 drops below it
 *  (caption). At ratio 1.25 → [1.953, 1.5625, 1.398, 1.118, 1.0, 0.9], close to
 *  the previous hand-tuned [2.0, 1.6, 1.32, 1.15, 1.0, 0.9]. Pure (CQS query). */
export function headingScales(ratio: string): number[] {
  const r = Number(ratio);
  const base = Number.isFinite(r) && r > 0 ? r : 1.25; // corrupt → current default
  return [
    base ** 3, // h1
    base ** 2, // h2
    base ** 1.5, // h3
    base ** 0.5, // h4
    1.0, // h5 = body size, set apart by weight
    0.9, // h6 = caption/overline below body
  ];
}

/** The heading-ratio sink: fan the six computed scales onto documentElement as
 *  --h1-scale … --h6-scale in ONE place (headingRatioSetting.bind(headingScaleSink())).
 *  styles.css multiplies each --hN-scale into its line's font-size calc. One sink
 *  fanning a derived map — never N scattered setProperty calls. Command/CQS: void. */
export function headingScaleSink(): (ratio: string) => void {
  return (ratio) => {
    const scales = headingScales(ratio);
    scales.forEach((s, i) =>
      document.documentElement.style.setProperty(`--h${i + 1}-scale`, String(s)),
    );
  };
}
