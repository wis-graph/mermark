import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Style-contract for "탐색기(사이드바) 텍스트를 ⌘±(--font-scale) 줌에 통합"
// (_workspace/01_architect_design.md 확정 1~4). A안 채택: `.sidebar-aside` root
// is the SOLE --font-scale multiplication point
// (`calc(13px * var(--font-scale, 1))`); every sidebar-scoped font-size/glyph
// size below it is a 13px-base em fraction — never a fresh px literal — so
// the scale factor is inherited once, not re-applied per selector (SIDEBAR
// ZOOM RULE anchor comment above `.sidebar-aside` in styles.css).
//
// Same technique as tests/sidebar-contrast.test.ts's ruleBlock(): read
// styles.css as TEXT and regex-extract "selector -> {...} block" pairs — a
// zero-runtime-cost style contract, not a CSS parser.
describe("sidebar font-size zoom integration (style contract)", () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
  const css = readFileSync(cssPath, "utf8");
  // Strip comments before the whole-sheet sweep (T2) so a comment containing
  // a stray brace can never desync the (selector, block) pairing. ruleBlock()
  // (T1/T3, single-selector lookups) doesn't need this — it already anchors
  // on the selector text itself.
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

  // Pulls the declaration block of the FIRST rule whose selector text appears
  // in the sheet (tests/sidebar-contrast.test.ts's ruleBlock convention,
  // reused verbatim so both style-contract tests read the same way).
  function ruleBlock(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const strict = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    if (strict) return strict[1];
    const grouped = css.match(new RegExp(escaped + "[^{}]*\\{([^}]*)\\}"));
    if (!grouped) throw new Error(`no CSS rule found for selector ${selector}`);
    return grouped[1];
  }

  const ROOT_SELECTOR = ".sidebar-aside";
  const ROOT_FONT_SIZE_RE = /font-size:\s*calc\(\s*13px\s*\*\s*var\(--font-scale,\s*1\)\s*\)/;

  it("T1: .sidebar-aside root is the sole --font-scale multiplication point", () => {
    const block = ruleBlock(ROOT_SELECTOR);
    expect(block).toMatch(ROOT_FONT_SIZE_RE);
  });

  // T2: sweep EVERY sidebar-scoped rule block in the sheet — a prefix sweep,
  // not an enumerated selector list, so a future sidebar selector is
  // automatically covered (design decision 1's "실행 가능한 이름": the
  // sweep IS the named rule, not a comment). The `.sidebar-aside` root is the
  // one declared exception (T1 owns its exact calc shape).
  const SIDEBAR_PREFIX_RE = /(^|[\s,>~+])\.(sidebar-|outline-|explorer-|recent-|favorites-|path-label)/;

  function sweepRuleBlocks(): Array<{ selector: string; block: string }> {
    const rules: Array<{ selector: string; block: string }> = [];
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cssNoComments))) {
      rules.push({ selector: m[1].trim(), block: m[2] });
    }
    return rules;
  }

  const sidebarRules = sweepRuleBlocks().filter((r) => SIDEBAR_PREFIX_RE.test(r.selector));

  it("T2 setup sanity: the sweep actually found sidebar-scoped rule blocks", () => {
    expect(sidebarRules.length).toBeGreaterThan(10);
  });

  it("T2: no sidebar-scoped rule (other than the .sidebar-aside root) declares a px font-size", () => {
    const offenders: string[] = [];
    for (const { selector, block } of sidebarRules) {
      const fontSizeDecls = block.match(/font-size:\s*[^;]+;/g) ?? [];
      for (const decl of fontSizeDecls) {
        if (selector === ROOT_SELECTOR) {
          if (!ROOT_FONT_SIZE_RE.test(decl)) offenders.push(`${selector} :: ${decl} (root must be the calc form)`);
          continue;
        }
        if (/\dpx/.test(decl)) offenders.push(`${selector} :: ${decl}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // T3: glyph em contract (design 확정 4, G1~G9 table).
  // Scoped to the width/height DECLARATION values only (not the whole rule
  // block) — a block-wide "no px anywhere" check would false-positive on
  // unrelated fallbacks like `var(--radius-sm, 6px)`, which isn't a size this
  // feature owns.
  function sizeDecl(block: string, prop: "width" | "height"): string {
    const match = block.match(new RegExp(`${prop}:\\s*([^;]+);`));
    if (!match) throw new Error(`no ${prop} declaration in block: ${block}`);
    return match[1].trim();
  }

  it("T3 (G1): .explorer-chevron box is a 16/13 em fraction", () => {
    const block = ruleBlock(".explorer-chevron");
    expect(sizeDecl(block, "width")).toBe("calc(16em / 13)");
    expect(sizeDecl(block, "height")).toBe("calc(16em / 13)");
  });

  it("T3 (G2): .explorer-chevron .icon / .explorer-glyph .icon fill their box (100%)", () => {
    // ruleBlock's grouped-selector fallback tolerates the comma/newline
    // between the two selector arms — no need to reproduce exact whitespace.
    const block = ruleBlock(".explorer-chevron .icon");
    expect(sizeDecl(block, "width")).toBe("100%");
    expect(sizeDecl(block, "height")).toBe("100%");
  });

  it("T3 (G3): .explorer-glyph box is a 16/13 em fraction (new rule — was unsized, svg attr ruled)", () => {
    const block = ruleBlock(".explorer-glyph");
    expect(sizeDecl(block, "width")).toBe("calc(16em / 13)");
    expect(sizeDecl(block, "height")).toBe("calc(16em / 13)");
  });

  it("T3 (G4): .explorer-star box is a 20/13 em fraction", () => {
    const block = ruleBlock(".explorer-star");
    expect(sizeDecl(block, "width")).toBe("calc(20em / 13)");
    expect(sizeDecl(block, "height")).toBe("calc(20em / 13)");
  });

  it("T3 (G5): .explorer-star .icon is 1em x 1em", () => {
    const block = ruleBlock(".explorer-star .icon");
    expect(sizeDecl(block, "width")).toBe("1em");
    expect(sizeDecl(block, "height")).toBe("1em");
  });

  // Audit 04 (2026-07-11, 🔴 2): this glyph sits inside .favorites-header
  // .sidebar-header, whose OWN font-size is calc(11em / 13) — an 11px-base,
  // not the 13px root base. A bare 1em here resolved against that 11px
  // base (13->11px shrink at scale=1, still scaling but from the wrong
  // floor). calc(13em / 11) recovers the 13px-base size against the 11px
  // parent (13/11 * 11 = 13).
  it("T3 (G6): .favorites-header-glyph .icon is a 13/11 em fraction (11px-base parent)", () => {
    const block = ruleBlock(".favorites-header-glyph .icon");
    expect(sizeDecl(block, "width")).toBe("calc(13em / 11)");
    expect(sizeDecl(block, "height")).toBe("calc(13em / 11)");
  });

  it("T3 (G7): .favorites-remove box is an 18/13 em fraction", () => {
    const block = ruleBlock(".favorites-remove");
    expect(sizeDecl(block, "width")).toBe("calc(18em / 13)");
    expect(sizeDecl(block, "height")).toBe("calc(18em / 13)");
  });

  it("T3 (G8): .favorites-remove .icon is a 12/13 em fraction", () => {
    const block = ruleBlock(".favorites-remove .icon");
    expect(sizeDecl(block, "width")).toBe("calc(12em / 13)");
    expect(sizeDecl(block, "height")).toBe("calc(12em / 13)");
  });

  it("T3 (G9): .favorites-item reserves 2em on the right for the absolutely-positioned remove button", () => {
    const block = ruleBlock(".favorites-item");
    expect(block).toMatch(/padding:\s*4px\s+2em\s+4px\s+8px/);
  });

  // T4: fallback arithmetic — every em fraction above, evaluated at scale=1
  // (--font-scale unset defaults to 1, and the 13px root base is unchanged),
  // must reproduce the ORIGINAL px value exactly. Proves scale=1 pixel
  // parity by arithmetic rather than a live DOM measurement (that's the CDP
  // golden's job — this is the fast, deterministic half of the same claim).
  const EM_FRACTION_CASES: Array<[numerator: number, denominator: number, expectedPx: number]> = [
    [11, 13, 11], // .sidebar-header / .path-label
    [12, 13, 12], // .favorites-remove .icon
    [16, 13, 16], // .explorer-chevron / .explorer-glyph
    [18, 13, 18], // .favorites-remove
    [20, 13, 20], // .explorer-star
  ];

  it.each(EM_FRACTION_CASES)("T4: calc(%dem / %d) at 13px base reproduces %dpx", (numerator, denominator, expectedPx) => {
    const px = (numerator / denominator) * 13;
    expect(px).toBeCloseTo(expectedPx, 10);
  });

  it("T4: bare 1em / 2em fallback to 13px / 26px (13px-base identity)", () => {
    const BASE_PX = 13;
    expect(1 * BASE_PX).toBe(13); // .outline-item / .recent-name / .favorites-name
    expect(2 * BASE_PX).toBe(26); // .favorites-item right padding (G9)
  });

  // Audit 04 (🔴 2): T4's fixed-13-base cases above can't catch a wrong BASE
  // (only a wrong fraction against the right base) — that's exactly how G6's
  // 1em-against-11px-base bug survived T4 originally. This case proves the
  // G6 fix's arithmetic against its ACTUAL 11px-base parent, not the 13px root.
  it("T4 (G6, 11px-base): calc(13em / 11) at an 11px base reproduces 13px", () => {
    const BASE_PX_11 = 11;
    const px = (13 / 11) * BASE_PX_11;
    expect(px).toBeCloseTo(13, 10);
  });

  // Audit 04 (🔴 1, low-priority follow-up): the four <button>-hosted glyphs
  // (G4/G5/G7/G8) sit inside .explorer-star / .favorites-remove, and a
  // <button>'s UA stylesheet gives it its OWN font-size (~13.33px on macOS
  // Chrome, NOT --font-scale-aware) unless the rule explicitly re-inherits.
  // Without `font: inherit`, every em fraction above resolves against that
  // fixed UA size instead of the 13px sidebar root, so the glyph silently
  // ignores ⌘± zoom. This sweeps every sidebar <button> rule (the ones that
  // size a glyph in em) for that declaration, the way T2 sweeps font-size.
  const SIDEBAR_BUTTON_GLYPH_HOSTS = [".explorer-star", ".favorites-remove"];

  it.each(SIDEBAR_BUTTON_GLYPH_HOSTS)("T5: %s (a <button>) declares font: inherit so its em glyphs track the sidebar root", (selector) => {
    const block = ruleBlock(selector);
    expect(block).toMatch(/font:\s*inherit\s*;/);
  });
});
