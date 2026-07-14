import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Style-contract for "뷰어 크기는 셸 .viewer-panel의 max-width:94vw/max-height:92vh
// 봉투가 SOLE OWNER" (team-lead sizing fix, 2026-07). Three viewers (excel,
// html, hwp) each independently invented their own px-capped copy of that
// envelope (`min(90vw, 960px)` etc.) — on a 4K display those caps clamped the
// modal to ~25-30% of the screen even though every one of them says "grow with
// the viewport" in the same breath. Fixed by deleting the px caps (see
// src/extensions/excel-viewer/index.ts, src/extensions/html-viewer/index.ts,
// styles.css's .hwp-viewer). This test is the GATE that stops the next viewer
// (PDF/DOCX/PPTX/CSV) from reinventing the same bug.
//
// SAME technique as tests/viewer-zoom.test.ts (which this file sits right
// next to): regex-extract selector -> block pairs from CSS text (styles.css
// AND src/extensions/**/*.ts's injected <style> template-literal strings),
// zero runtime cost, no real browser needed.
describe("viewer size envelope (style contract — no viewer reinvents its own px cap)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cssPath = join(ROOT, "src", "styles.css");
  const css = readFileSync(cssPath, "utf8");
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

  function sweepRuleBlocks(source: string): Array<{ selector: string; block: string }> {
    const rules: Array<{ selector: string; block: string }> = [];
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) rules.push({ selector: m[1].trim(), block: m[2] });
    return rules;
  }

  // Scope: every viewer-owned selector, built-in or extension-injected.
  // `.settings-*` is deliberately OUT of this prefix — the settings modal is
  // a declared, separate exception (see styles.css's comment on
  // `.settings-modal`), not a viewer.
  const VIEWER_SIZE_PREFIX_RE = /(^|[\s,>~+])\.(viewer-|image-viewer-|excel-viewer|html-viewer|hwp-viewer)/;

  // Declared exceptions — window CHROME with a genuinely fixed hit-target
  // size, not a content/document size envelope. Named explicitly (not
  // pattern-matched) so a new selector can't accidentally exempt itself by
  // resembling one of these.
  const CHROME_EXEMPT_SELECTORS = new Set<string>([".viewer-panel-close"]);

  const SIZE_PROPS = ["width", "height", "max-width", "max-height"] as const;

  /** True when `declValue` is a bare px literal this rule authored itself —
   *  as opposed to a `var(--custom-prop, 600px)` reference, where the px is
   *  only a FALLBACK for an otherwise JS-computed value (hwp-viewer.ts's
   *  `--hwp-page-width`, applied dynamically from the panel's actual
   *  rendered size — not a static cap). A value that starts with `var(` is
   *  never flagged; everything else is checked for a `<digits>px` literal.
   *  Pure query. */
  function isBarePxLiteral(declValue: string): boolean {
    const trimmed = declValue.trim();
    if (trimmed.startsWith("var(")) return false;
    return /\d+px/.test(trimmed);
  }

  function findPxOffenders(rules: Array<{ selector: string; block: string }>): string[] {
    const offenders: string[] = [];
    for (const { selector, block } of rules) {
      if (CHROME_EXEMPT_SELECTORS.has(selector)) continue;
      for (const prop of SIZE_PROPS) {
        const re = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+);`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(block))) {
          if (isBarePxLiteral(m[1])) offenders.push(`${selector} :: ${prop}: ${m[1].trim()};`);
        }
      }
    }
    return offenders;
  }

  const cssViewerRules = sweepRuleBlocks(cssNoComments).filter((r) => VIEWER_SIZE_PREFIX_RE.test(r.selector));

  it("setup sanity: the styles.css sweep actually found viewer-scoped rule blocks (not a silently-empty glob)", () => {
    expect(cssViewerRules.length).toBeGreaterThan(3);
  });

  it("no viewer-scoped styles.css rule declares a bare px width/height/max-width/max-height", () => {
    expect(findPxOffenders(cssViewerRules)).toEqual([]);
  });

  // Extension-injected <style> strings (excel/html viewers can't touch
  // styles.css — api-fence — so their size rules live in a JS template
  // literal instead).
  function walkTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) out.push(...walkTsFiles(p));
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  function extractInjectedStyleStrings(file: string): string[] {
    const src = readFileSync(file, "utf8");
    const strings: string[] = [];
    const re = /\.textContent\s*=\s*`([\s\S]*?)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) strings.push(m[1]);
    return strings;
  }

  const extensionsDir = join(ROOT, "src", "extensions");
  const extensionFiles = walkTsFiles(extensionsDir);
  const extensionCssBlocks = extensionFiles.flatMap((f) => extractInjectedStyleStrings(f));
  const extensionSizeRules = extensionCssBlocks
    .flatMap((c) => sweepRuleBlocks(c))
    .filter((r) => VIEWER_SIZE_PREFIX_RE.test(r.selector));

  it("setup sanity: the extension sweep actually found viewer-scoped injected CSS rules", () => {
    expect(extensionFiles.length).toBeGreaterThan(0);
    expect(extensionSizeRules.length).toBeGreaterThan(0);
  });

  it("no extension-injected viewer rule declares a bare px width/height/max-width/max-height", () => {
    expect(findPxOffenders(extensionSizeRules)).toEqual([]);
  });

  // Negative path (양성·음성 둘 다 실증): feed the sweep a synthetic block
  // shaped exactly like the excel-viewer regression this gate exists to
  // catch, and confirm it actually turns red — proving the assertions above
  // aren't vacuously true because the regex never matches anything.
  it("negative control: the sweep DOES flag the old regressed .excel-viewer rule (px cap reintroduced)", () => {
    const regressed = ".excel-viewer { width: min(90vw, 960px); max-height: min(85vh, 640px); }";
    const rules = sweepRuleBlocks(regressed);
    const offenders = findPxOffenders(rules);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.some((o) => o.includes("960px"))).toBe(true);
    expect(offenders.some((o) => o.includes("640px"))).toBe(true);
  });

  // Negative control for the var()-fallback exemption itself: prove a
  // *literal* px cap on .hwp-viewer-page (not the var(...) form it actually
  // uses) WOULD be flagged, so the exemption is narrowly scoped to dynamic
  // custom-property references and not accidentally exempting the whole
  // selector.
  it("negative control: a literal (non-var) px width on .hwp-viewer-page would be flagged", () => {
    const regressed = ".hwp-viewer-page { width: 600px; }";
    const offenders = findPxOffenders(sweepRuleBlocks(regressed));
    expect(offenders).toEqual([".hwp-viewer-page :: width: 600px;"]);
  });

  // Positive control: the var()-fallback form actually used in styles.css
  // today is NOT flagged (dynamic, JS-computed — see hwp-viewer.ts's
  // pageBaseWidth/applyHwpZoom).
  it("var(--custom-prop, <fallback>px) is exempt (dynamic value, not a static cap)", () => {
    const dynamic = ".hwp-viewer-page { width: var(--hwp-page-width, 600px); }";
    expect(findPxOffenders(sweepRuleBlocks(dynamic))).toEqual([]);
  });

  it(".viewer-panel-close's fixed 28px hit-target is the one declared chrome exception", () => {
    const chrome = ".viewer-panel-close { width: 28px; height: 28px; }";
    expect(findPxOffenders(sweepRuleBlocks(chrome))).toEqual([]);
  });
});
