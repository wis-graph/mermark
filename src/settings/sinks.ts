// CSS-var sinks: the command side of the SSOT. A setting is the single writer;
// these sinks subscribe and fan the value onto documentElement. No setting is
// read here — the value arrives as the argument (main.ts binds setting → sink).
import { applyThemeVars } from "../theme";
import { themeToVars, type Theme } from "./theme-schema";
import { googleFontHref } from "./app";

const WEBFONT_LINK_ID = "mermark-webfont";

/** The web-font sink: given the EFFECTIVE family + reading-font stack, it (1)
 *  ensures exactly one <link id="mermark-webfont"> in <head> pointing at
 *  googleFontHref(family) — create or swap href — or removes it when the family
 *  is empty/invalid, and (2) writes --reading-font. ONE place owns the <head>
 *  link lifecycle (create/replace/remove) — never N scattered injections, so
 *  --reading-font keeps a single writer. googleFontHref is the only URL builder
 *  it calls, so there is no path around the sanitization. Offline: a failed
 *  <link> load just leaves the fallback stack on --reading-font; the browser
 *  swallows the 404/timeout silently (no JS fetch, no console-error path).
 *  Command/CQS: returns void. */
export function webFontSink(): (effective: { family: string; stack: string }) => void {
  return ({ family, stack }) => {
    const href = googleFontHref(family);
    const existing = document.getElementById(WEBFONT_LINK_ID) as HTMLLinkElement | null;
    if (href === null) {
      existing?.remove(); // empty/invalid → no link
    } else {
      const link =
        existing ??
        (Object.assign(document.createElement("link"), {
          id: WEBFONT_LINK_ID,
          rel: "stylesheet",
        }) as HTMLLinkElement);
      if (link.href !== href) link.href = href; // create or swap
      if (!existing) document.head.appendChild(link);
    }
    document.documentElement.style.setProperty("--reading-font", stack);
  };
}

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

/** The heading-font sink: a stack writes an inline --font-heading (outranking
 *  the theme's own :root[data-theme] declaration); null REMOVES the property so
 *  the theme's default (claude's Georgia) or --reading-font shows through again.
 *  cssVarSink can't do this — it only ever sets, never removes — so this stays a
 *  distinct sink with its own writer. Command/CQS: void. */
export function headingFontSink(): (stack: string | null) => void {
  return (stack) => {
    if (stack === null) document.documentElement.style.removeProperty("--font-heading");
    else document.documentElement.style.setProperty("--font-heading", stack);
  };
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
