import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { builtInTheme } from "../src/settings/theme-schema";

// Style-contract for the "explorer sidebar is a strong theme-inverted tone,
// with its own foreground palette" design
// (_workspace/01_architect_design.md — SUPERSEDES the "은은한 recessed sidebar"
// design; that contract lived in tests/sidebar-recessed.test.ts, now deleted).
//
// The sidebar shell (.sidebar-aside — shared by explorer/outline/recent) paints
// --sidebar-bg/fg/muted/accent/border tokens instead of the global --surface/
// --fg/--muted/--accent/--border. --sidebar-bg is `color-mix(in srgb, var(--bg)
// N%, <pole>)` with N <= 20 (pole-dominant invariant, design decision 2) and
// pole direction inverted per theme (dark: light pole, light/claude: dark
// pole, design decision 3) — that's what keeps the fixed --sidebar-fg/muted/
// accent readable under ANY custom --bg a JSON theme injects.
//
// Same technique as tests/editor-selection.test.ts's ruleBlock(): read
// styles.css as TEXT and regex-extract "selector -> first {...} block", so
// this is a zero-runtime-cost style contract, not a CSS parser. Color
// arithmetic (relativeLuminance/contrastRatio/color-mix evaluation) mirrors
// scripts/sidebar-contrast-golden.mjs's runtime read — same formulas, cross-
// referenced in comments there.
describe("sidebar strong-contrast palette (style contract)", () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
  const css = readFileSync(cssPath, "utf8");

  // Pulls the declaration block of the FIRST rule whose selector text appears
  // in the sheet, up to the first `{...}` that follows it. Relaxed vs a
  // strict "selector immediately followed by {": several sidebar selectors
  // are one arm of a comma-separated group (e.g. `.explorer-star.is-favorite,
  // \n.explorer-label:hover .explorer-star.is-favorite,\n...`), so anything
  // that isn't a brace is allowed between the selector text and the first
  // `{` (tests/editor-selection.test.ts's ruleBlock convention, extended for
  // grouped selectors per _workspace/01_architect_plan.md T1).
  function ruleBlock(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Strict match first — selector immediately followed by `{` — so a
    // selector that is also a substring of some earlier, unrelated grouped
    // selector (e.g. ".title-bar" inside ".title-bar.mac") still lands on
    // its OWN rule, not a wrong one found by scanning forward past a comma.
    const strict = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    if (strict) return strict[1];
    // Grouped-selector fallback: this selector is one arm of a comma-
    // separated group (e.g. `.explorer-star.is-favorite,\n.explorer-label:hover
    // .explorer-star.is-favorite,\n...`), so allow anything that isn't a
    // brace between the selector text and the first `{` (tests/editor-
    // selection.test.ts's ruleBlock convention, extended per
    // _workspace/01_architect_plan.md T1).
    const grouped = css.match(new RegExp(escaped + "[^{}]*\\{([^}]*)\\}"));
    if (!grouped) throw new Error(`no CSS rule found for selector ${selector}`);
    return grouped[1];
  }

  // Pulls a single `--name: value;` declaration's raw value out of a rule
  // block (throws if absent — doubles as an existence assertion).
  function declOf(block: string, varName: string): string {
    const match = block.match(new RegExp(`--${varName}:\\s*([^;]+);`));
    if (!match) throw new Error(`no --${varName} declaration in block: ${block}`);
    return match[1].trim();
  }

  // --- color arithmetic (WCAG contrast + CSS color-mix "in srgb" evaluation) ---

  function hexToRgb(hex: string): [number, number, number] {
    const clean = hex.replace("#", "");
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    const int = parseInt(full.slice(0, 6), 16);
    return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
  }

  function relativeLuminance([r, g, b]: [number, number, number]): number {
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
    const lA = relativeLuminance(a);
    const lB = relativeLuminance(b);
    const lighter = Math.max(lA, lB);
    const darker = Math.min(lA, lB);
    return (lighter + 0.05) / (darker + 0.05);
  }

  // `color-mix(in srgb, A p%, B)` interpolates component-wise in (non-linear)
  // sRGB space — a plain weighted average of the two colors' 0-255 channels.
  function evaluateColorMix(
    weightPercent: number,
    a: [number, number, number],
    b: [number, number, number],
  ): [number, number, number] {
    const wa = weightPercent / 100;
    const wb = 1 - wa;
    return [0, 1, 2].map((i) => a[i] * wa + b[i] * wb) as [number, number, number];
  }

  // Parses `color-mix(in srgb, var(--bg) N%, #hex)` → { weight: N, pole }.
  function parseBgMix(value: string): { weight: number; pole: [number, number, number] } {
    const match = value.match(/color-mix\(in srgb,\s*var\(--bg\)\s*(\d+)%,\s*(#[0-9a-fA-F]{3,8})\)/);
    if (!match) throw new Error(`not a var(--bg)-anchored color-mix: ${value}`);
    return { weight: Number(match[1]), pole: hexToRgb(match[2]) };
  }

  // Named domain queries (intent-review convention — see design decision 2/3):
  // the bg-weight is the "pole-dominant invariant", pole lightness is the
  // "theme-inversion direction" contract. Both are pure, both read straight
  // off the parsed color-mix — no inline arithmetic hiding the rule.
  function bgWeightOf(mixValue: string): number {
    return parseBgMix(mixValue).weight;
  }
  function poleIsLight(mixValue: string): boolean {
    return relativeLuminance(parseBgMix(mixValue).pole) > 0.5;
  }
  function sidebarBgOf(mixValue: string, themeBgHex: string): [number, number, number] {
    const { weight, pole } = parseBgMix(mixValue);
    return evaluateColorMix(weight, hexToRgb(themeBgHex), pole);
  }

  const BARE_GLOBAL_VAR = /var\(--(fg|muted|accent|border|caret)[,)]/;

  const THEME_BLOCKS = [
    { name: "dark", selector: ":root" },
    { name: "light", selector: ':root[data-theme="light"]' },
    { name: "claude", selector: ':root[data-theme="claude"]' },
  ] as const;

  const EXPECTED_POLE_IS_LIGHT: Record<string, boolean> = { dark: false, light: false, claude: false };

  // Design decision 4's full remap table, sidebar-scoped selectors that carry
  // a color declaration — the sweep's source of truth. `.workspace-sash` is
  // deliberately excluded (design decision 4 #4 — it stays on the global
  // --border/--accent, it lives outside the sidebar shell). Missing even one
  // row here would let that one element silently keep reading the global
  // (un-inverted) palette against the inverted sidebar bg.
  const SIDEBAR_SCOPED_SELECTORS = [
    ".sidebar-aside",
    ".sidebar-header",
    ".outline-empty",
    ".outline-item",
    ".outline-item:hover",
    ".outline-item:active",
    ".outline-item:focus-visible",
    ".outline-h4",
    ".outline-h5",
    ".outline-h6",
    ".explorer-label",
    ".explorer-item > .explorer-label:hover",
    ".explorer-item.is-selected > .explorer-label",
    ".explorer-item.is-focused > .explorer-label",
    ".explorer-chevron",
    ".explorer-glyph",
    ".explorer-dir > .explorer-label > .explorer-glyph",
    ".explorer-star",
    ".explorer-label:hover .explorer-star",
    ".explorer-star:hover",
    ".explorer-star.is-favorite",
    ".explorer-star:focus-visible",
    ".explorer-file.is-nonmd > .explorer-label",
    ".recent-empty",
    ".recent-item",
    ".recent-item:hover",
    ".recent-item:active",
    ".recent-item:focus-visible",
    ".path-label",
    ".explorer-favorites",
    ".favorites-header-glyph",
    ".favorites-empty",
    ".favorites-item",
    ".favorites-item:hover",
    ".favorites-item:active",
    ".favorites-item:focus-visible",
    ".favorites-remove",
    ".favorites-remove:hover",
    // M6 (_workspace/01_architect_design.md rehome + design-polish pass):
    // the left command group's buttons repaint in --sidebar-* tokens when
    // they rehome into a rail's .sidebar-top-strip; the combined
    // selected+focused explorer row is a new selector (was two separate
    // rules), both still --sidebar-* only.
    ".explorer-item.is-selected.is-focused > .explorer-label",
    ".sidebar-top-strip .chrome-btn",
    ".sidebar-top-strip .chrome-btn:hover",
    '.sidebar-top-strip .chrome-btn[aria-expanded="true"]',
  ];

  it.each(THEME_BLOCKS)("$name declares --sidebar-bg anchored to var(--bg)", ({ selector }) => {
    const value = declOf(ruleBlock(selector), "sidebar-bg");
    expect(value).toContain("var(--bg)");
  });

  it.each(THEME_BLOCKS)(
    "$name's --sidebar-bg keeps the bg weight <=20% (pole-dominant invariant, design decision 2)",
    ({ selector }) => {
      const value = declOf(ruleBlock(selector), "sidebar-bg");
      expect(bgWeightOf(value)).toBeLessThanOrEqual(20);
    },
  );

  it.each(THEME_BLOCKS)(
    "$name's --sidebar-bg pole direction matches the theme-inversion contract (design decision 3)",
    ({ name, selector }) => {
      const value = declOf(ruleBlock(selector), "sidebar-bg");
      expect(poleIsLight(value)).toBe(EXPECTED_POLE_IS_LIGHT[name]);
    },
  );

  it.each([
    ["dark", ":root"],
    ["light", ':root[data-theme="light"]'],
    ["claude", ':root[data-theme="claude"]'],
  ] as const)(
    "%s sidebar foreground palette reads against --sidebar-bg (fg>=7 AAA, muted>=4.5 AA, accent>=3 non-text)",
    (name, selector) => {
      const block = ruleBlock(selector);
      const mixValue = declOf(block, "sidebar-bg");
      const fgHex = declOf(block, "sidebar-fg");
      const mutedHex = declOf(block, "sidebar-muted");
      const accentHex = declOf(block, "sidebar-accent");
      expect(declOf(block, "sidebar-border")).toBeTruthy(); // existence only — no numeric contrast contract (design decision 3)
      const sbg = sidebarBgOf(mixValue, builtInTheme(name).colors.bg);
      expect(contrastRatio(hexToRgb(fgHex), sbg)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(hexToRgb(mutedHex), sbg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hexToRgb(accentHex), sbg)).toBeGreaterThanOrEqual(3);
    },
  );

  it.each(SIDEBAR_SCOPED_SELECTORS)(
    "%s consumes --sidebar-* only, not the bare global --fg/--muted/--accent (remap regression guard)",
    (selector) => {
      const block = ruleBlock(selector);
      expect(block).not.toMatch(BARE_GLOBAL_VAR);
    },
  );

  it(".sidebar-aside shell paints sidebar-scoped bg/fg/border, not --surface", () => {
    const block = ruleBlock(".sidebar-aside");
    expect(block).toMatch(/background:\s*var\(--sidebar-bg\)/);
    expect(block).toMatch(/color:\s*var\(--sidebar-fg\)/);
    expect(block).toMatch(/border-right:[^;]*var\(--sidebar-border\)/);
    expect(block).not.toMatch(/var\(--surface\)/);
  });

  it.each([".cm-codeblock", ".settings-modal"])(
    "%s keeps its existing background: var(--surface) (--surface consumers untouched)",
    (selector) => {
      const block = ruleBlock(selector);
      expect(block).toMatch(/background:\s*var\(--surface\)/);
    },
  );

  // M6 design-polish pass (contract CHANGE, not a regression): 심리스 크롬 —
  // .title-bar/.status-bar now paint --bg (the same canvas color as the
  // editor), not --surface. The two-tone contrast that used to separate
  // "chrome" from "canvas" lives only in the sidebar rail (--sidebar-bg) now.
  // This also fixes the light/claude theme luminance inversion where the old
  // --surface chrome read lighter than the --bg canvas beneath it.
  it.each([".title-bar", ".status-bar"])("%s paints --bg, not --surface (seamless chrome)", (selector) => {
    const block = ruleBlock(selector);
    expect(block).toMatch(/background:\s*var\(--bg\)/);
    expect(block).not.toMatch(/var\(--surface\)/);
  });

  it.each([
    ["dark", null],
    ["light", 'data-theme="light"'],
    ["claude", 'data-theme="claude"'],
  ] as const)(
    "%s theme's --bg literal in styles.css matches builtInTheme(...).colors.bg (CSS <-> schema zero-drift)",
    (name, attr) => {
      const selector = attr ? `:root[${attr}]` : ":root";
      const block = ruleBlock(selector);
      expect(declOf(block, "bg")).toBe(builtInTheme(name).colors.bg);
    },
  );
});
