// Pure color-space conversions + WCAG contrast for the theme color inspector.
// Dependency-free (hand-rolled, ~60 lines) — this file is only reached from the
// settings panel and from tests, never from the boot path, but stays free of a
// color library anyway so it costs nothing even if that changes later.

/** HSL as the inspector's sliders see it: h in [0,360), s/l in [0,100]. */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** Parse a 3- or 6-digit hex string into 0-255 RGB channels. Pure query. */
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 0-255 RGB channels → a 6-digit lowercase hex string. Pure query — the
 *  inverse of hexToRgb, and the shared tail of hslToHex. */
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** hex → HSL. Pure query; the inspector's "current value" readout for the H/S/L
 *  sliders. */
export function hexToHsl(hex: string): Hsl {
  const [r0, g0, b0] = hexToRgb(hex);
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

/** HSL → hex. Pure query; the inverse of hexToHsl, called on every slider drag. */
export function hslToHex({ h, s, l }: Hsl): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** WCAG relative luminance (sRGB → linear, ITU-R BT.709 weights). Pure query —
 *  the shared basis for contrastRatio. Not exported: callers only ever want the
 *  ratio between two colors, never a luminance in isolation. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors — always ≥1, order-independent.
 *  Pure query; the single contrast primitive shared by the theme schema's
 *  comment-color regression gate (tests/settings-theme-schema.test.ts) and the
 *  panel's live contrast readout. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}
