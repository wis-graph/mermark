import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { THEME_TARGETS } from "../src/settings/panel/theme-preview";

// 2026-08 감사 반영 2차 (round-2 감사 Medium #1, "폴백 체인이 두 파일에서 손으로
// 동기화된다"): `theme-preview.ts`의 `ThemeTarget.colorFallback`/`bgFallback`과
// `styles.css`의 실제 `var(--x, <fallback>)` 리터럴은 지금까지 **서로 참조 없이
// 각자 하드코딩**돼 있었다 — round-1 Major #3(거짓 앵커: 미리보기는 `--border`를
// 칠했는데 실앱은 `--block-edge`를 씀)이 정확히 이 동기화가 깨졌던 사례다.
// 이 파일은 "패턴 도입"이 아니라 **크로스파일 테스트 1건**(감사 권고 그대로)이다
// — 두 파일 모두 각자 자기 값만 단언하는 기존 테스트(`theme-visual-editor.test.ts`
// 의 "paint the EXACT fallback chain", `sidebar-contrast.test.ts`의 BLOCK FILL
// 단언) 위에, **서로를 직접 대조**하는 계층 하나를 얹는다. 한쪽만 바뀌면 여기가
// 즉시 red가 된다 — 신규 9키뿐 아니라 기존 라운드-1 키(bold/italic/code/
// highlight/comment/link/h1~h6/bg/surface/border/accent/muted/fg)까지 전수로.
describe("theme-preview.ts fallback chains match styles.css byte-for-byte (cross-file drift gate)", () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
  const css = readFileSync(cssPath, "utf8");

  // sidebar-contrast.test.ts의 ruleBlock과 동일한 관용구(정규식으로 "선택자 →
  // 첫 {...} 블록"을 뽑는 것) — CSS 파서를 새로 들이지 않는다는 감사의 YAGNI
  // 가드를 그대로 따른다.
  function ruleBlock(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const strict = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    if (strict) return strict[1]!;
    const grouped = css.match(new RegExp(escaped + "[^{}]*\\{([^}]*)\\}"));
    if (!grouped) throw new Error(`no CSS rule found for selector ${selector}`);
    return grouped[1]!;
  }

  /** "이 CSS 블록 안에서 `var(--varName, ...)`의 폴백 부분이 정확히 뭔가" —
   *  정규식이 아니라 괄호 깊이를 직접 세는 순수 파서다(정규식은 `var(--bold-
   *  italic-color, var(--italic-color, inherit))`처럼 중첩된 `var()`를 한
   *  번에 정확히 못 잡는다 — 감사의 "정규식이 CSS 포맷 변화에 쉽게 깨지면
   *  유지비가 더 크다"는 우려에 대한 답: 정규식 대신 이 얇은 스캐너로 중첩을
   *  정확히 다룬다). `var(--x)`(폴백 없음)면 `null`. varName이 블록에 전혀
   *  없으면 `undefined`(호출자가 "이 선택자에 그 var가 안 쓰인다"와 "폴백이
   *  없다"를 구분하게). Pure query. */
  function extractFallback(block: string, varName: string): string | null | undefined {
    const needle = `var(${varName}`;
    const idx = block.indexOf(needle);
    if (idx === -1) return undefined;
    let i = idx + needle.length;
    while (block[i] === " ") i++;
    if (block[i] === ")") return null; // var(--x) — no fallback
    if (block[i] !== ",") {
      throw new Error(`unexpected character after ${varName} at index ${i} in block: ${block.slice(idx, idx + 40)}`);
    }
    i++; // skip comma
    while (block[i] === " ") i++;
    const start = i;
    let depth = 1; // we're inside the outer var(...)
    for (; i < block.length; i++) {
      if (block[i] === "(") depth++;
      else if (block[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error(`unbalanced parens extracting fallback for ${varName}`);
    return block.slice(start, i).trim();
  }

  // 이 자체가 회귀 게이트다: 정규식 대신 손수 짠 파서이므로, 중첩 var()를
  // 정확히 다루는지부터 직접 검증한다(아래 실제 크로스파일 단언들이 전부
  // 이 함수 위에 서 있으므로, 이 함수가 틀리면 나머지 전부가 무의미해진다).
  it("extractFallback correctly parses nested var(...) fallbacks (parser self-check)", () => {
    expect(extractFallback("color: var(--x);", "--x")).toBeNull();
    expect(extractFallback("color: var(--x, inherit);", "--x")).toBe("inherit");
    expect(extractFallback("color: var(--x, var(--y, inherit));", "--x")).toBe("var(--y, inherit)");
    expect(extractFallback("background: var(--x, transparent);", "--y")).toBeUndefined();
  });

  // target id → 실앱 소비 지점(들). 설계 결정 3/5 표(`_workspace/01_ui_design.md`,
  // `01_ui2_design.md`)와 동일한 앵커 — THEME_TARGETS의 colorVar/bgVar를 그
  // 안에서 찾아 fallback을 뽑는다. 라운드 구분 없이 24개 타깃 전수.
  const CSS_SITE: Record<string, { selector: string; varField: "colorVar" | "bgVar"; fallbackField: "colorFallback" | "bgFallback" }[]> = {
    bg: [{ selector: "body", varField: "colorVar", fallbackField: "colorFallback" }],
    surface: [{ selector: ".cm-editor .cm-foldPlaceholder", varField: "colorVar", fallbackField: "colorFallback" }],
    border: [{ selector: ".cm-hr", varField: "colorVar", fallbackField: "colorFallback" }],
    accent: [{ selector: ".cm-footnote-ref", varField: "colorVar", fallbackField: "colorFallback" }],
    muted: [{ selector: ".status-bar", varField: "colorVar", fallbackField: "colorFallback" }],
    fg: [{ selector: "body", varField: "colorVar", fallbackField: "colorFallback" }],
    link: [
      { selector: ".cm-link", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-link", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    bold: [
      { selector: ".cm-strong", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-strong", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    italic: [
      { selector: ".cm-em", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-em", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    // 2026-08 golden-master fix (`_workspace/03_qa2_report.md`): `.cm-strong.cm-em`
    // was dead CSS (no element ever carries both classes — Emphasis/StrongEmphasis
    // always nest, never coexist on one node). The real consumption site is now
    // TWO direction-dependent selectors (`.cm-em .cm-strong` / `.cm-strong .cm-em`
    // — see styles.css's boldItalic comment). theme-preview.ts's sample text for
    // this target is `***사흘째만은***` (triple-star), which nests strong INSIDE
    // em (bold wins — confirmed by mounting the real editor, see
    // tests/bold-italic-nesting.test.ts), so `.cm-em .cm-strong` is the site that
    // must match this target's fallback fields.
    boldItalic: [
      { selector: ".cm-em .cm-strong", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-em .cm-strong", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    strike: [
      { selector: ".cm-strike", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-strike", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    code: [
      { selector: ".cm-inline-code", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-inline-code", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    highlight: [
      { selector: ".cm-highlight", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-highlight", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    quote: [
      { selector: ".cm-blockquote", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-blockquote", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    quoteBar: [{ selector: ".cm-blockquote", varField: "colorVar", fallbackField: "colorFallback" }],
    codeBlock: [
      { selector: ".cm-codeblock", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-codeblock", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    highlightBlock: [{ selector: ".cm-highlight-block", varField: "colorVar", fallbackField: "colorFallback" }],
    comment: [
      { selector: ".cm-comment", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-comment", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    h1: [
      { selector: ".cm-editor .cm-line.cm-h1", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-editor .cm-line.cm-h1", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    h2: [
      { selector: ".cm-editor .cm-line.cm-h2", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-editor .cm-line.cm-h2", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    h3: [
      { selector: ".cm-editor .cm-line.cm-h3", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-editor .cm-line.cm-h3", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    h4: [
      { selector: ".cm-editor .cm-line.cm-h4", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-editor .cm-line.cm-h4", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    h5: [
      { selector: ".cm-editor .cm-line.cm-h5", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-editor .cm-line.cm-h5", varField: "bgVar", fallbackField: "bgFallback" },
    ],
    h6: [
      { selector: ".cm-editor .cm-line.cm-h6", varField: "colorVar", fallbackField: "colorFallback" },
      { selector: ".cm-editor .cm-line.cm-h6", varField: "bgVar", fallbackField: "bgFallback" },
    ],
  };

  it("covers every THEME_TARGETS entry that has a colorVar/bgVar consumption site (no id silently skipped)", () => {
    for (const t of THEME_TARGETS) {
      expect(CSS_SITE[t.id], `THEME_TARGETS id "${t.id}" has no CSS_SITE entry — add one`).toBeDefined();
    }
    // and the reverse: no stale CSS_SITE entry for a target that no longer exists.
    const ids = new Set(THEME_TARGETS.map((t) => t.id));
    for (const id of Object.keys(CSS_SITE)) {
      expect(ids.has(id), `CSS_SITE has a stale entry "${id}" not in THEME_TARGETS`).toBe(true);
    }
  });

  for (const t of THEME_TARGETS) {
    const sites = CSS_SITE[t.id];
    if (!sites) continue; // covered by the coverage test above
    for (const site of sites) {
      const varName = t[site.varField];
      if (!varName) continue; // e.g. quoteBar has no bgVar — nothing to check
      it(`${t.id}.${site.fallbackField} matches styles.css's ${site.selector} { ...${varName}... } literally`, () => {
        const block = ruleBlock(site.selector);
        const cssFallback = extractFallback(block, varName);
        expect(cssFallback, `styles.css's ${site.selector} never references ${varName}`).not.toBeUndefined();
        const targetFallback = t[site.fallbackField] ?? null;
        expect(targetFallback).toBe(cssFallback);
      });
    }
  }
});

// design `_workspace/01_architect_design.md` §4.1/§4.4 (round 3): block
// geometry (--block-radius/--block-padding) fallback literals in styles.css
// ARE the zero-drift baseline — a theme with no geometry key configured must
// render codeblock/blockquote BYTE-IDENTICAL to before this feature. This is
// a regression snap, not a coverage gate: it pins the exact fallback literals
// so an accidental edit to one of them is caught immediately (the highlight
// block is the one deliberate EXCEPTION — §2's intentional new rounded
// default, snapped separately below).
describe("block geometry CSS fallback literals (zero-drift default — round 3)", () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
  const css = readFileSync(cssPath, "utf8");

  function ruleBlock(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const strict = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    if (strict) return strict[1]!;
    const grouped = css.match(new RegExp(escaped + "[^{}]*\\{([^}]*)\\}"));
    if (!grouped) throw new Error(`no CSS rule found for selector ${selector}`);
    return grouped[1]!;
  }

  it(".cm-codeblock: --block-radius falls back to var(--radius-md), --block-padding to .7em/.9em (unchanged from pre-feature)", () => {
    const block = ruleBlock(".cm-codeblock");
    expect(block).toContain("border-radius: var(--block-radius, var(--radius-md))");
    expect(block).toContain("padding: var(--block-padding, .7em) var(--block-padding, .9em)");
  });

  it(".cm-blockquote: --block-padding falls back to .75em (unchanged); -first/-last fall back to radius 0 / padding 0 (no prior geometry existed)", () => {
    const block = ruleBlock(".cm-blockquote");
    expect(block).toContain("padding-left: var(--block-padding, .75em)");
    const first = ruleBlock(".cm-blockquote-first");
    expect(first).toContain("var(--block-radius, 0)");
    expect(first).toContain("padding-top: var(--block-padding, 0)");
    const last = ruleBlock(".cm-blockquote-last");
    expect(last).toContain("var(--block-radius, 0)");
    expect(last).toContain("padding-bottom: var(--block-padding, 0)");
  });

  // The ONE deliberate exception (§2): highlight block gets a rounded corner
  // even with geometry unset — fallback is --radius-sm, not 0.
  it(".cm-highlight-block-first/-last: --block-radius falls back to var(--radius-sm, 6px) — the intentional new rounded default", () => {
    const first = ruleBlock(".cm-highlight-block-first");
    expect(first).toContain("var(--block-radius, var(--radius-sm, 6px))");
    const last = ruleBlock(".cm-highlight-block-last");
    expect(last).toContain("var(--block-radius, var(--radius-sm, 6px))");
  });
});

// Part C, plan step 15: static proof of design §5.5's "no new subscription"
// claim — the geometry sliders write through themeVarsSink (the single
// documentElement writer), and the mini frames consume that SAME var chain
// via plain CSS, not a listener of their own. Computed-style verification is
// the golden master's job (settings-golden.mjs scenario 4); this test only
// pins that theme-panel.css's text still declares the consuming var(...) —
// if a future edit swaps a mini frame back to a hardcoded literal, this goes
// red immediately instead of silently breaking live-reflection.
describe("theme-panel.css mini frames consume --block-radius/--block-padding (design §5.5 static wiring proof)", () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/settings/panel/theme-panel.css");
  const css = readFileSync(cssPath, "utf8");

  function ruleBlock(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const strict = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    if (strict) return strict[1]!;
    const grouped = css.match(new RegExp(escaped + "[^{}]*\\{([^}]*)\\}"));
    if (!grouped) throw new Error(`no CSS rule found for selector ${selector}`);
    return grouped[1]!;
  }

  it.each([".theme-codeblock", ".theme-quote", ".theme-highlightblock"])(
    "%s declares var(--block-radius and var(--block-padding",
    (selector) => {
      const block = ruleBlock(selector);
      expect(block).toContain("var(--block-radius");
      expect(block).toContain("var(--block-padding");
    },
  );
});
