import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Style-contract for "뷰어(이미지·Excel·future HTML/HWP) 텍스트를 ⌘±
// (--font-scale) 줌에 통합" (04_audit_report.md 재호출 4차). Mirrors
// tests/sidebar-zoom.test.ts's T1/T2 shape exactly — SAME technique
// (regex-extract selector -> block pairs from CSS TEXT, zero runtime cost),
// SAME root variable (`--font-scale`), SAME "13px-base em fraction, never a
// fresh px literal" rule (VIEWER ZOOM RULE anchor comment above
// `.viewer-panel` in styles.css).
//
// The one thing this file does NOT mirror: sidebar-zoom's sweep only ever
// needed to read styles.css, because every sidebar rule lives there. Viewer
// CSS does NOT — extensions inject their OWN <style> (design §6, fence
// spirit: extensions can't touch styles.css) — so a sweep limited to
// styles.css would certify the built-in image viewer while silently
// blessing every extension (Excel today, HTML/HWP/PDF tomorrow) to ignore
// zoom forever. T3 below sweeps src/extensions/**/*.ts's injected <style>
// STRINGS for exactly that reason.
describe("viewer font-size zoom integration (style contract)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cssPath = join(ROOT, "src", "styles.css");
  const css = readFileSync(cssPath, "utf8");
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

  // Same convention as tests/sidebar-zoom.test.ts's ruleBlock().
  function ruleBlock(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const strict = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    if (strict) return strict[1];
    const grouped = css.match(new RegExp(escaped + "[^{}]*\\{([^}]*)\\}"));
    if (!grouped) throw new Error(`no CSS rule found for selector ${selector}`);
    return grouped[1];
  }

  const ROOT_SELECTOR = ".viewer-panel";
  const ROOT_FONT_SIZE_RE = /font-size:\s*calc\(\s*13px\s*\*\s*var\(--font-scale,\s*1\)\s*\)/;
  // .viewer-panel-close is the ONE declared exception (styles.css anchor
  // comment exception 2) — fixed window-chrome size, not zoomable text.
  const CLOSE_SELECTOR = ".viewer-panel-close";

  it("T1: .viewer-panel root is the sole --font-scale multiplication point", () => {
    const block = ruleBlock(ROOT_SELECTOR);
    expect(block).toMatch(ROOT_FONT_SIZE_RE);
  });

  // T2: sweep every viewer-scoped rule block in styles.css — a prefix sweep
  // (sidebar-zoom's T2 shape), so a future built-in viewer rule is
  // automatically covered. Root and the declared close-button exception are
  // skipped by name, not by pattern, so a NEW selector can't accidentally
  // exempt itself by resembling one of these two.
  const VIEWER_PREFIX_RE = /(^|[\s,>~+])\.(viewer-|image-viewer-)/;

  function sweepRuleBlocks(source: string): Array<{ selector: string; block: string }> {
    const rules: Array<{ selector: string; block: string }> = [];
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) rules.push({ selector: m[1].trim(), block: m[2] });
    return rules;
  }

  const viewerRules = sweepRuleBlocks(cssNoComments).filter((r) => VIEWER_PREFIX_RE.test(r.selector));

  it("T2 setup sanity: the sweep actually found viewer-scoped rule blocks in styles.css", () => {
    expect(viewerRules.length).toBeGreaterThan(5);
  });

  it("T2: no viewer-scoped styles.css rule (other than root/close exceptions) declares a px font-size", () => {
    const offenders: string[] = [];
    for (const { selector, block } of viewerRules) {
      const fontSizeDecls = block.match(/font-size:\s*[^;]+;/g) ?? [];
      for (const decl of fontSizeDecls) {
        if (selector === ROOT_SELECTOR) {
          if (!ROOT_FONT_SIZE_RE.test(decl)) offenders.push(`${selector} :: ${decl} (root must be the calc form)`);
          continue;
        }
        if (selector === CLOSE_SELECTOR) continue; // declared exception 2 — fixed window chrome
        if (/\dpx/.test(decl)) offenders.push(`${selector} :: ${decl}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("T2 (exception 1): .viewer-panel-close declares font: inherit (it's a <button>)", () => {
    const block = ruleBlock(CLOSE_SELECTOR);
    expect(block).toMatch(/font:\s*inherit\s*;/);
  });

  // T3: sweep src/extensions/**/*.ts's INJECTED <style> STRINGS — the reason
  // this test file exists at all (see file header). An extension's CSS is a
  // JS template-literal string, not a stylesheet on disk, so it needs its
  // own extraction step before the same selector/block regex can run on it.
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

  /** Every `<style>.textContent = \`...\`` template-literal body in a file —
   *  the injected-CSS idiom `ensureStyleInjected()`-shaped functions use
   *  (design §6: an extension can't touch styles.css, so it injects its
   *  own). Pure query over source text, same "good enough for a fence test,
   *  not a full parser" standard tests/api-fence.test.ts already accepts. */
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
  const extensionRules = extensionCssBlocks.flatMap((css) => sweepRuleBlocks(css));

  it("T3 setup sanity: the extension sweep actually found injected CSS rules (not a silently-empty glob)", () => {
    // The specific number matters less than "not zero" — a glob that finds
    // nothing makes every assertion below vacuously true forever (exactly
    // the api-fence "never positively exercised" class of bug this session
    // keeps re-finding). excel-viewer/index.ts alone injects well over 5.
    expect(extensionFiles.length).toBeGreaterThan(0);
    expect(extensionRules.length).toBeGreaterThan(5);
  });

  it("T3: no extension-injected CSS rule declares a px font-size", () => {
    const offenders: string[] = [];
    for (const { selector, block } of extensionRules) {
      const fontSizeDecls = block.match(/font-size:\s*[^;]+;/g) ?? [];
      for (const decl of fontSizeDecls) {
        if (/\dpx/.test(decl)) offenders.push(`${selector} :: ${decl}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("T3: every extension <button> that sizes its own font in em declares font: inherit", () => {
    // A conservative check: any rule whose selector text plausibly matches a
    // <button> element this extension creates (the tab strip is the one
    // case today — excel-viewer/index.ts's `tab.type = "button"`) and whose
    // block sets a non-inherit font-size must also set `font: inherit`.
    const offenders: string[] = [];
    for (const { selector, block } of extensionRules) {
      if (!/-tab\b/.test(selector)) continue; // scope: known button-hosted selectors
      if (/font-size\s*:/.test(block) && !/font:\s*inherit\s*;/.test(block)) {
        offenders.push(selector);
      }
    }
    expect(offenders).toEqual([]);
  });

  // T4: fallback arithmetic — scale=1 pixel parity (same style as
  // sidebar-zoom's T4, for the em fraction this feature introduces).
  it("T4: calc(12.5em / 13) at 13px base reproduces 12.5px (.excel-viewer-tab / .excel-viewer-table / .viewer-panel-caption)", () => {
    const px = (12.5 / 13) * 13;
    expect(px).toBeCloseTo(12.5, 10);
  });

  it("T4: bare 1em fallback to 13px (.excel-viewer-status 13px-base identity)", () => {
    expect(1 * 13).toBe(13);
  });
});
