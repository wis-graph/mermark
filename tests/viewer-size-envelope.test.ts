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

// Second style-contract, sitting next to the px-cap one above but guarding a
// DIFFERENT failure mode of the same "viewer size envelope" bug class
// (team-lead sizing fix, 2026-07). The px-cap gate above catches a viewer
// that reinvents a SMALLER-than-envelope box; this one catches a viewer that
// silently COLLAPSES inside a correctly-sized one.
//
// THE BUG THIS GUARDS: .html-viewer shipped with `width: 92vw; max-height:
// 88vh;` and NO `height`. `max-height` alone leaves a box's height as `auto`
// — CSS auto-height means "shrink to fit content", not "claim the cap as a
// target". A DOCUMENT viewer's content (an <iframe srcdoc>, in html-viewer's
// case) has no reliable intrinsic height of its own to shrink-to-fit against
// — an <iframe>'s box is sized by ITS OWN CSS box model, not by the document
// inside it, so with nothing else forcing a height the box fell back to the
// UA default of exactly 150px, regardless of the 88vh cap sitting unused
// above it. Measured directly via CDP at a 3840×2160 viewport: the panel
// rendered 253px tall (150px of which was this exact iframe-default
// collapse) against an available 1900px cap — roughly 12% of the intended
// envelope. Fixed by adding `height: 88vh` alongside the existing
// `max-height: 88vh` (src/extensions/html-viewer/index.ts) so the box has a
// DEFINITE height for the whole `flex: 1` chain beneath it
// (.viewer-panel-body → .html-viewer-frame-wrap → the iframe's `height:
// 100%`) to actually resolve against.
//
// NOT every viewer should be forced onto this rule — excel-viewer (a small
// sheet's panel SHOULD shrink to fit 3 rows, not claim a fixed 88vh box full
// of dead whitespace) and image-viewer (a small image SHOULD render small,
// not stretch to fill the envelope) are content-driven BY DESIGN, not bugs;
// see excel-viewer/index.ts's `.excel-viewer` comment for the design
// rationale this test deliberately does not re-litigate. So this gate is
// scoped to an explicit allowlist of viewers that are envelope-driven BY
// CONTRACT (arbitrary document content, no natural "small" size), the same
// "declared exception, not pattern-matched" shape CHROME_EXEMPT_SELECTORS
// above uses — a new viewer opts into this gate by being added here, it is
// never silently swept in or out by a selector regex.
describe("viewer size envelope (height, not just max-height, for envelope-driven document viewers)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  function sweepRuleBlocks(source: string): Array<{ selector: string; block: string }> {
    const rules: Array<{ selector: string; block: string }> = [];
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) rules.push({ selector: m[1].trim(), block: m[2] });
    return rules;
  }

  function declaresProp(block: string, prop: string): boolean {
    return new RegExp(`(?:^|[;\\s])${prop}\\s*:`, "").test(block);
  }

  /** Selectors that MUST claim their envelope regardless of content — a
   *  viewer earns a place here only when its content has no natural "small"
   *  size (an arbitrary document, not a small sheet/image). Currently only
   *  `.html-viewer` — it is the one this gate's fix actually landed for.
   *  `.hwp-viewer` (styles.css) and `.pdf-viewer`
   *  (src/extensions/pdf-viewer/index.ts) share the exact same
   *  `width: 92vw; max-height: 88vh;` shape with no `height` today and have
   *  the SAME latent bug (pdf-viewer only avoids showing it because a
   *  multi-page PDF's own canvas content happens to be tall enough to fill
   *  the cap on its own) — each is a separate in-flight fix outside this
   *  change's scope; add it here the moment its own `height: 88vh` (or
   *  equivalent) lands, so this gate keeps it from regressing back to
   *  max-height-only later. Deliberately NOT auto-derived from the px-cap
   *  gate's `VIEWER_SIZE_PREFIX_RE` above — opting a viewer into "must claim
   *  full envelope" is a content-shape judgment call (document vs.
   *  small-and-shrinkable), not a mechanical sweep. */
  const ENVELOPE_DRIVEN_SELECTORS = [".html-viewer", ".pdf-viewer"];

  function findMaxHeightWithoutHeight(source: string): string[] {
    // Comments MUST be stripped before sweeping (mirrors the px-cap gate's
    // cssNoComments above) — without this, a selector immediately preceded
    // by a `/* ... */` block captures the comment's own trailing text as
    // part of "the selector" (the sweep's `[^{}]+` runs from the last `}` to
    // the next `{`, and a comment has neither), so `.html-viewer` would
    // never `.trim()` down to exactly `.html-viewer` and this gate would
    // silently never match anything — caught by this file's own negative
    // control below going green when it should have been red on a first
    // draft of this test.
    const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders: string[] = [];
    for (const { selector, block } of sweepRuleBlocks(noComments)) {
      if (!ENVELOPE_DRIVEN_SELECTORS.includes(selector)) continue;
      if (declaresProp(block, "max-height") && !declaresProp(block, "height")) {
        offenders.push(selector);
      }
    }
    return offenders;
  }

  function extractInjectedStyleStrings(file: string): string[] {
    const src = readFileSync(file, "utf8");
    const strings: string[] = [];
    const re = /\.textContent\s*=\s*`([\s\S]*?)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) strings.push(m[1]);
    return strings;
  }

  it(".html-viewer declares height alongside max-height (envelope-driven, not content-collapsed)", () => {
    const htmlViewerFile = join(ROOT, "src", "extensions", "html-viewer", "index.ts");
    const css = extractInjectedStyleStrings(htmlViewerFile).join("\n");
    expect(findMaxHeightWithoutHeight(css)).toEqual([]);
  });

  it(".pdf-viewer declares height alongside max-height (envelope-driven, not content-collapsed)", () => {
    const pdfViewerFile = join(ROOT, "src", "extensions", "pdf-viewer", "index.ts");
    const css = extractInjectedStyleStrings(pdfViewerFile).join("\n");
    expect(findMaxHeightWithoutHeight(css)).toEqual([]);
  });

  // Negative control (양성·음성 실증, 기존 px-cap 게이트와 같은 원칙): feed the
  // sweep the EXACT regressed shape this gate exists to catch and confirm it
  // actually turns red — proving the assertion above isn't vacuously true.
  it("negative control: max-height alone (no height) on an envelope-driven selector IS flagged", () => {
    const regressed = ".html-viewer { width: 92vw; max-height: 88vh; }";
    expect(findMaxHeightWithoutHeight(regressed)).toEqual([".html-viewer"]);
  });

  // Positive control: max-height WITH height is not flagged.
  it("max-height alongside an explicit height is NOT flagged", () => {
    const fixed = ".html-viewer { width: 92vw; height: 88vh; max-height: 88vh; }";
    expect(findMaxHeightWithoutHeight(fixed)).toEqual([]);
  });

  // Scope control: a selector NOT on the allowlist (e.g. the deliberately
  // content-driven .excel-viewer) is never flagged even with the exact same
  // max-height-only shape — proves this gate only judges viewers that opted
  // in, matching excel-viewer's documented "shrink to content" design.
  it("a non-allowlisted selector with the same max-height-only shape is NOT flagged (scope control)", () => {
    const excel = ".excel-viewer { width: 85vw; max-height: 88vh; }";
    expect(findMaxHeightWithoutHeight(excel)).toEqual([]);
  });
});
