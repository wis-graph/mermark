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
