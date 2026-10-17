import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { builtInTheme, type PresetName } from "../src/settings/theme-schema";
import { contrastRatio } from "../src/settings/panel/color-math";

// D1 AA gate (2026-10-18 design review §5): text/UI contrast of the three
// built-in themes is computed from styles.css TEXT + builtInTheme() alone —
// no DOM, deterministic. Only pairs the review measured as sub-AA are gated,
// plus structural guards that stop the fixes from regressing (callout colour
// is ONE derived rule, never per-theme overrides; accent-fill text goes
// through --on-accent). scripts/theme-contrast-golden.mjs re-checks the same
// pairs against REAL computed values (cascade / specificity mistakes).
const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(HERE, "../src/styles.css"), "utf8");
const themePanelCss = readFileSync(resolve(HERE, "../src/settings/panel/theme-panel.css"), "utf8");

const THEMES: PresetName[] = ["dark", "light", "claude"];
const CALLOUT_TYPES = [
  "abstract", "info", "todo", "tip", "success", "question",
  "warning", "failure", "danger", "bug", "example",
] as const;

// ---------- css text helpers ----------
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function ruleBlock(selector: string): string {
  const m = css.match(new RegExp(esc(selector) + "\\s*\\{([^}]*)\\}"));
  if (!m) throw new Error(`no CSS rule for ${selector}`);
  return m[1];
}
function themeBlock(theme: PresetName): string {
  // dark has no [data-theme] block of its own: it IS :root.
  return theme === "dark" ? ruleBlock(":root") : ruleBlock(`:root[data-theme="${theme}"]`);
}
function declIn(block: string, name: string): string | null {
  const m = block.match(new RegExp(`(?:^|[;\\s])${esc(name)}:\\s*([^;]+);`));
  return m ? m[1].replace(/\/\*.*?\*\//g, "").trim() : null;
}

// ---------- colour arithmetic (sRGB, straight alpha) ----------
type Rgba = [number, number, number, number];
const clamp = (n: number) => Math.max(0, Math.min(255, n));
function parseColor(v: string): Rgba {
  const s = v.trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  if (s === "transparent") return [0, 0, 0, 0];
  throw new Error(`unparsable colour: ${v}`);
}
const toHex = ([r, g, b]: Rgba) =>
  "#" + [r, g, b].map((c) => Math.round(clamp(c)).toString(16).padStart(2, "0")).join("");
/** Composite `top` (with its alpha) over an opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
}
function ratio(fg: Rgba, bg: Rgba): number {
  return contrastRatio(toHex(over(fg, bg)), toHex(bg));
}
/** Split on top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** Resolve a CSS value to a colour for `theme`: hex/rgba literals, var(--x) via
 *  the JSON tokens (builtInTheme) → theme block → :root, and
 *  color-mix(in srgb, A p%, B [q%]) (transparent keeps A's colour, scales alpha). */
function resolveColor(value: string, theme: PresetName): Rgba {
  const v = value.trim();
  const mixM = v.match(/^color-mix\(in srgb,(.*)\)$/s);
  if (mixM) {
    const [a, b] = splitArgs(mixM[1]);
    const pa = a.match(/^(.*?)\s+([\d.]+)%$/s);
    const pb = b.match(/^(.*?)\s+([\d.]+)%$/s);
    const colA = resolveColor(pa ? pa[1] : a, theme);
    const colB = resolveColor(pb ? pb[1] : b, theme);
    const wa = pa ? +pa[2] / 100 : pb ? 1 - +pb[2] / 100 : 0.5;
    const wb = 1 - wa;
    const alpha = colA[3] * wa + colB[3] * wb;
    if (alpha === 0) return [0, 0, 0, 0];
    const ch = (i: number) => (colA[i] * colA[3] * wa + colB[i] * colB[3] * wb) / alpha;
    return [ch(0), ch(1), ch(2), alpha];
  }
  const varM = v.match(/^var\(--([\w-]+)(?:,\s*(.*))?\)$/s);
  if (varM) {
    const name = varM[1];
    const json = builtInTheme(theme).colors as Record<string, string | undefined>;
    const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    // Core tokens are injected by the JSON sink (inline) and win over CSS blocks.
    if (["bg", "fg", "accent", "link", "surface", "border", "muted"].includes(camel) && json[camel]) {
      return parseColor(json[camel]!);
    }
    const own = declIn(themeBlock(theme), `--${name}`) ?? (theme === "dark" ? null : declIn(themeBlock("dark"), `--${name}`));
    if (own) return resolveColor(own, theme);
    if (varM[2]) return resolveColor(varM[2], theme);
    throw new Error(`unresolved var --${name} in ${theme}`);
  }
  return parseColor(v);
}
const tok = (name: string, theme: PresetName) => resolveColor(`var(--${name})`, theme);

// ---------- (a) callout heads: one derived rule, AA in every theme ----------
describe("callout head colour is ONE derived rule (🔴2)", () => {
  const head = ruleBlock(".cm-callout-head");
  const mix = head.match(/color:\s*color-mix\(in srgb,\s*var\(--callout-hue,\s*var\(--fg\)\)\s*(\d+)%,\s*var\(--fg\)\)/);

  it(".cm-callout-head derives its colour from --callout-hue x --fg", () => {
    expect(mix).not.toBeNull();
  });

  it("no per-theme callout overrides survive (no :root[data-theme=light] .cm-callout-*)", () => {
    expect(css.match(/:root\[data-theme="[a-z]+"\]\s+\.cm-callout-/g)).toBeNull();
    // and no per-type literal head colours: `.cm-callout-<t>.cm-callout-head { color: #… }`
    for (const t of CALLOUT_TYPES) {
      expect(css).not.toMatch(new RegExp(`\\.cm-callout-${t}\\.cm-callout-head\\s*\\{`));
    }
  });

  it("every typed block declares --callout-hue and uses it for the rule line", () => {
    for (const t of CALLOUT_TYPES) {
      const b = ruleBlock(`.cm-callout-${t}`);
      expect(declIn(b, "--callout-hue"), t).toMatch(/^#[0-9a-f]{6}$/i);
      expect(b, t).toMatch(/border-left-color:\s*var\(--callout-hue\)/);
      expect(b, t).toMatch(/background:\s*rgba\(/);
    }
  });

  for (const theme of THEMES) {
    it(`${theme}: all 11 heads >= 4.5:1 on their own 12% tint`, () => {
      const pct = +mix![1];
      const { fg, bg } = builtInTheme(theme).colors;
      const bgC = parseColor(bg);
      for (const t of CALLOUT_TYPES) {
        const b = ruleBlock(`.cm-callout-${t}`);
        const hue = parseColor(declIn(b, "--callout-hue")!);
        const tint = parseColor(b.match(/background:\s*(rgba\([^)]*\))/)![1]);
        const surface = over(tint, bgC);
        const headColor = resolveColor(`color-mix(in srgb, ${toHex(hue)} ${pct}%, ${fg})`, theme);
        expect(ratio(headColor, surface), `${theme}/${t}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

// ---------- (b) muted / code text on their surfaces ----------
describe("preset text tones hold AA (§5)", () => {
  it("styles.css theme blocks mirror builtInTheme for the retuned tokens (zero-drift)", () => {
    expect(declIn(themeBlock("light"), "--muted")).toBe(builtInTheme("light").colors.muted);
    expect(declIn(themeBlock("claude"), "--muted")).toBe(builtInTheme("claude").colors.muted);
    expect(declIn(themeBlock("claude"), "--code-color")).toBe(builtInTheme("claude").colors.code);
  });

  it("light --muted >= 4.5 on bg and on surface", () => {
    const c = builtInTheme("light").colors;
    expect(contrastRatio(c.muted, c.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.muted, c.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("claude --muted >= 4.5 on surface (settings help / inactive segment) and bg", () => {
    const c = builtInTheme("claude").colors;
    expect(contrastRatio(c.muted, c.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.muted, c.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("claude inline code >= 4.5 on its veil (surface 60% over bg)", () => {
    const veil = over(tok("surface-veil", "claude"), tok("bg", "claude"));
    expect(ratio(tok("code-color", "claude"), veil)).toBeGreaterThanOrEqual(4.5);
  });
});

// ---------- (c)(d)(e) derived accent tokens ----------
describe("derived accent tokens (🔴4) — not in the JSON schema, follow any custom theme", () => {
  for (const theme of THEMES) {
    it(`${theme}: --on-accent on --accent >= 4.5`, () => {
      expect(ratio(tok("on-accent", theme), tok("accent", theme))).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: --seg-active-fg on --seg-active-bg >= 4.5`, () => {
      expect(ratio(tok("seg-active-fg", theme), tok("seg-active-bg", theme))).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: --accent-ui >= 3:1 on surface and bg (non-text, WCAG 1.4.11)`, () => {
      expect(ratio(tok("accent-ui", theme), tok("surface", theme))).toBeGreaterThanOrEqual(3);
      expect(ratio(tok("accent-ui", theme), tok("bg", theme))).toBeGreaterThanOrEqual(3);
    });
    it(`${theme}: --focus-ring (composited on surface) >= 3:1`, () => {
      const surface = tok("surface", theme);
      expect(ratio(tok("focus-ring", theme), surface)).toBeGreaterThanOrEqual(3);
    });
  }

  it("claude active segment: chip edge vs track >= 3:1 (state boundary)", () => {
    const ring = declIn(themeBlock("claude"), "--seg-active-ring")!;
    const start = ring.indexOf("color-mix(");
    let depth = 0, end = start;
    for (let i = start; i < ring.length; i++) {
      if (ring[i] === "(") depth++;
      if (ring[i] === ")" && --depth === 0) { end = i + 1; break; }
    }
    const firstMix = ring.slice(start, end);
    const edge = resolveColor(firstMix, "claude");
    const track = over(resolveColor("color-mix(in srgb, var(--fg) 4%, transparent)", "claude"), tok("surface", "claude"));
    expect(ratio(edge, track)).toBeGreaterThanOrEqual(3);
  });

  it("light/dark keep their ink/sky active chip unchanged (--seg-active-* inherit :root)", () => {
    for (const theme of ["dark", "light"] as const) {
      expect(toHex(tok("seg-active-bg", theme))).toBe(toHex(tok("accent", theme)));
      expect(toHex(tok("seg-active-fg", theme))).toBe(toHex(tok("bg", theme)));
    }
  });
});

// ---------- (f) substitution-miss guards ----------
describe("accent-fill text always goes through --on-accent; focus rings through --focus-ring", () => {
  function rules(source: string): { sel: string; body: string }[] {
    const out: { sel: string; body: string }[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) out.push({ sel: m[1].trim(), body: m[2] });
    return out;
  }
  const all = [...rules(css), ...rules(themePanelCss)];

  it("no rule paints `background: var(--accent)` together with `color: var(--bg)`", () => {
    const offenders = all.filter(
      (r) => /(^|[;\s])background:\s*var\(--accent\)/.test(r.body) && /(^|[;\s])color:\s*var\(--bg\)/.test(r.body),
    );
    expect(offenders.map((r) => r.sel)).toEqual([]);
  });

  it("no focus ring shadow mixes --accent at 50%/70% (use var(--focus-ring); sidebar scope uses --sidebar-accent)", () => {
    const offenders = all.filter(
      (r) => /:focus-visible/.test(r.sel) && /\d+px\s+color-mix\(in srgb,\s*var\(--accent\)\s*(50|70)%/.test(r.body),
    );
    expect(offenders.map((r) => r.sel)).toEqual([]);
  });
});
