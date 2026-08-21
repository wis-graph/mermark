import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RENDER, attachTeardown, runTeardown } from "../src/settings/panel/controls";
import { themeJsonSetting, syncJsonToPreset } from "../src/settings/app";
import { builtInTheme, parseTheme, serializeTheme, themeToVars } from "../src/settings/theme-schema";
import { THEME_TARGETS } from "../src/settings/panel/theme-preview";

// 2026-08 round-1 audit Minor recommendation, implemented in round 2 (fe-schema,
// 01_ui2_plan.md 갈래 A1 item 6): every THEME_TARGETS colorVar/bgVar must be a
// real key themeToVars emits — a typo'd var name silently under-paints (the
// button references a CSS var nothing ever writes). This is a coverage GATE
// against THAT class of bug, not a duplicate of theme-preview.ts's own table —
// it doesn't hand-list target ids, so it automatically extends to whatever
// THEME_TARGETS grows to (18 today, 24 once round-2's 5 new targets land).
describe("THEME_TARGETS var coverage (typo/drift gate)", () => {
  it("every colorVar and bgVar in THEME_TARGETS is a key themeToVars actually emits", () => {
    const emitted = new Set(Object.keys(themeToVars(builtInTheme("light"))));
    for (const t of THEME_TARGETS) {
      expect(emitted.has(t.colorVar), `${t.id}.colorVar "${t.colorVar}" is not emitted by themeToVars`).toBe(true);
      if (t.bgVar) {
        expect(emitted.has(t.bgVar), `${t.id}.bgVar "${t.bgVar}" is not emitted by themeToVars`).toBe(true);
      }
    }
  });
});

// 2026-08 redesign (design: _workspace/01_ui_design.md 결정 1): the 18-swatch
// grid is gone, replaced by a mini app frame (every target is a real click
// target rendered IN the sample document) + a docked color inspector. This
// file replaces the old "18 cards" assertions with assertions against that
// new structure — same theme JSON round-trip contract underneath.

describe("Theme mini-frame preview", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    themeJsonSetting.set(builtInTheme("light"));
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    runTeardown(el());
    host.remove();
    themeJsonSetting.set(builtInTheme("light"));
  });

  let mounted: HTMLElement | null = null;
  function el(): HTMLElement {
    return mounted!;
  }
  function mount(): HTMLElement {
    const row = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    mounted = row;
    host.appendChild(row);
    return row;
  }

  it("renders every THEME_TARGETS entry as a real button with data-target", () => {
    mount();
    for (const t of THEME_TARGETS) {
      const buttons = host.querySelectorAll(`[data-target="${t.id}"]`);
      expect(buttons.length, `target ${t.id} missing`).toBeGreaterThan(0);
    }
    // round 1: 18 (6 chrome/core + link/bold/italic/code/highlight/comment +
    // h1..h6). round 2 adds 5 new CLICK TARGETS (boldItalic/strike/quote/
    // quoteBar/codeBlock — 9 new schema keys, but boldItalic+boldItalicBg
    // share one target, same for strike/quote/codeBlock, and quoteBar has no
    // bg pair) = 18 + 5 = 23. round 3 adds 1 more (highlightBlock) = 24.
    expect(THEME_TARGETS.length).toBe(24);
  });

  // design plan B1.2: round-2's new rows sit at the array positions the plan
  // specifies relative to their neighbors — boldItalic/strike right after
  // italic (matching 문단 1's DOM order), quote/quoteBar/codeBlock right
  // before comment (matching the document's natural quote→code→comment
  // flow). This isn't "table order == full DOM order" (round-1's core rows
  // are grouped by concept, not position) — just these 5 new insertions.
  // round 3 (highlightBlock) sits right after codeBlock, still before comment
  // — the plan's "codeBlock 뒤·comment 앞" instruction.
  it("round-2/round-3 targets are inserted where the plan specifies (relative to italic/comment)", () => {
    const idx = (id: string) => THEME_TARGETS.findIndex((t) => t.id === id);
    const italicIdx = idx("italic");
    expect(idx("boldItalic")).toBe(italicIdx + 1);
    expect(idx("strike")).toBe(italicIdx + 2);

    const commentIdx = idx("comment");
    expect(idx("quote")).toBeLessThan(commentIdx);
    expect(idx("quoteBar")).toBeLessThan(commentIdx);
    expect(idx("codeBlock")).toBeLessThan(commentIdx);
    expect(idx("highlightBlock")).toBeLessThan(commentIdx);
    expect(idx("quote")).toBe(commentIdx - 4);
    expect(idx("quoteBar")).toBe(commentIdx - 3);
    expect(idx("codeBlock")).toBe(commentIdx - 2);
    expect(idx("highlightBlock")).toBe(commentIdx - 1);
  });

  it("renders the chrome anchors called out by the design (bg/surface/border/accent/muted)", () => {
    mount();
    const frame = host.querySelector<HTMLElement>('[data-target="bg"]')!;
    expect(frame.getAttribute("role")).toBe("button");
    expect(frame.getAttribute("aria-label")).toBe("에디터 배경색");
    expect(frame.tabIndex).toBe(0);

    expect(host.querySelector('[data-target="surface"]')).not.toBeNull();
    expect(host.querySelector('[data-target="border"]')).not.toBeNull();
    expect(host.querySelector('[data-target="accent"]')).not.toBeNull();
    expect(host.querySelector('[data-target="muted"]')).not.toBeNull();
  });

  it("renders H3~H6 as 4 independent buttons sized by their own CSS var", () => {
    mount();
    for (const id of ["h3", "h4", "h5", "h6"] as const) {
      const btn = host.querySelector<HTMLElement>(`[data-target="${id}"]`)!;
      expect(btn.tagName).toBe("BUTTON");
      expect(btn.style.color).toContain(`--${id}-color`);
    }
  });

  it("no chip row / '전체 목록으로 보기' fallback exists (design explicitly rejects it)", () => {
    mount();
    expect(host.querySelector(".theme-swatch-grid")).toBeNull();
    expect(host.textContent).not.toContain("전체");
  });

  // 2026-08 폴리시 리뷰 결정 1: "미리보기는 실앱이 그 요소를 렌더하는 모습과
  // 같아야 한다" — mermark의 라이브프리뷰가 커서가 없을 때 감추는 마커
  // (#, ##, [[ ]], ==)는 미리보기에서도 감춰야 하고, 실앱이 감추지 않는 것
  // (HTML 주석)은 그대로 남아야 한다. 이 테스트가 그 규칙을 잠근다 — 샘플
  // 문서를 늘릴 때 다시 "일부는 렌더/일부는 원문"으로 어긋나면 여기서 잡힌다.
  // 2026-08 폴리시 리뷰 2차: 사용자가 1차 결정을 뒤집었다 — "마커째 들어와도
  // 돼, 편집모드에선 마커 보이잖아 어차피". 진짜 문제는 마커가 보이는 것이
  // 아니라 일관성이 없던 것(제목/하이라이트/위키링크는 마커 O, bold/italic은
  // 마커 X)이었으므로, 이제는 반대 방향(전부 마커 포함)으로 통일한다. 이
  // 테스트가 그 통일성을 잠근다.
  it("shows every target's RAW markdown marker syntax (edit-mode look), never conceals any", () => {
    mount();
    const docText = host.querySelector(".theme-doc")!.textContent!;

    expect(docText).toContain("# 제주 여행 준비"); // H1 마커
    expect(docText).toContain("## 사흘째 아침"); // H2 마커
    expect(docText).toContain("**가볍게**"); // bold 마커
    expect(docText).toContain("*느슨하게*"); // italic 마커
    expect(docText).toContain("[[제주 숙소 목록]]"); // 위키링크 대괄호
    expect(docText).toContain("==환전은 출발 전에=="); // 하이라이트 마커
    expect(docText).toContain("`JX-2041`"); // 인라인 코드 백틱
    expect(docText).toContain("[^1]"); // 각주 참조의 raw 문법
    expect(docText).toContain("<!-- 지난 여행에서는 우산을 두 번 잃어버렸다 -->"); // HTML 주석(원래도 안 감춰짐)
    // round 2 추가
    expect(docText).toContain("***사흘째만은***"); // 볼드+이탤릭 마커
    expect(docText).toContain("~~완벽한 동선~~"); // 취소선 마커
  });

  // design decision 4의 명시적 예외 2건(EDIT_MODE_SAMPLE_TEXT의 doc comment):
  // 인용구는 `>` 마커를 안 쓰고, 코드블럭은 펜스(```)를 안 쓴다 — 실앱 편집
  // 모드에서 둘 다 conceal/atomic-widget이라 마커 없는 모습이 실물과 일치.
  it("quote and code-block samples have NO markers (design's explicit exceptions)", () => {
    mount();
    // Scoped to the quote text specifically — the comment line legitimately
    // contains ">" (as the closing "-->" of "<!-- ... -->"), so a doc-wide
    // scan for ">" would false-positive on that unrelated element.
    const quoteText = host.querySelector(".theme-quote-text")!.textContent!;
    expect(quoteText.startsWith(">")).toBe(false);
    const docText = host.querySelector(".theme-doc")!.textContent!;
    expect(docText).not.toContain("```"); // no fence marker
    expect(docText).toContain("짐을 줄이는 가장 확실한 방법은 가방을 작게 사는 것이다.");
    expect(docText).toContain('const bag = pack("가볍게");');
  });

  // 2026-08 폴리시 리뷰 2차 추가 지적: "**가볍게**싸고"(닫는 마커-다음 글자
  // 공백 누락)와 "둔다 [^1] ."(각주 히트박스 패딩이 공백처럼 보임)를
  // team-lead가 캡처에서 직접 읽고 잡았다. 정확한 어절 경계를 여기 잠근다.
  it("has no stray/missing whitespace around bold marker or the footnote ref", () => {
    mount();
    const docText = host.querySelector(".theme-doc")!.textContent!;

    expect(docText).toContain("**가볍게** 싸고"); // 닫는 마커 다음 공백 있음
    expect(docText).not.toContain("**가볍게**싸고"); // 공백 누락 재발 가드

    expect(docText).toContain("둔다[^1]."); // 각주는 앞뒤 공백 없이 붙는다(마크다운 관례)
    expect(docText).not.toContain("둔다 [^1]");
    expect(docText).not.toContain("[^1] .");
  });

  it("paints chrome colors on the right property, never as unreadable text ink", () => {
    mount();
    const finder = host.querySelector<HTMLElement>('[data-target="surface"]')!;
    expect(finder.style.background).toContain("--surface"); // fill, not text color
    expect(finder.style.color).not.toContain("--surface");

    // 2026-08 감사 반영(major #3): `border`'s anchor is the hr, not the quote
    // bar — paints its own top border, never text color.
    const hr = host.querySelector<HTMLElement>('[data-target="border"]')!;
    expect(hr.style.borderTop).toContain("--border");
    expect(hr.style.color).toBe("");
  });

  // design decision 5's "미리보기가 칠할 체인" column, checked byte-for-byte —
  // a mismatch here is the exact bug class round 1's audit caught (border
  // anchored to the wrong var). These strings must equal what the real
  // editor's styles.css rule for the same element resolves.
  it("round-2 targets paint the EXACT fallback chain design decision 5 specifies", () => {
    mount();
    const boldItalic = host.querySelector<HTMLElement>('[data-target="boldItalic"]')!;
    // 감사 반영 2차(fe-schema): `.cm-strong.cm-em`은 죽은 셀렉터였다 — 실제
    // 중첩은 마커 순서에 따라 방향이 갈린다. 미리보기 샘플("***사흘째만은***")은
    // 트리플스타 → 볼드가 이기는 방향(`.cm-em .cm-strong`)이므로 그 체인을
    // 미러링한다 — tests/theme-css-fallback-parity.test.ts가 이걸 styles.css와
    // 직접 대조해 크로스파일로 잠근다.
    expect(boldItalic.style.color).toBe("var(--bold-italic-color, var(--bold-color, inherit))");
    expect(boldItalic.style.background).toBe("var(--bold-italic-bg, var(--bold-bg, transparent))");

    const strike = host.querySelector<HTMLElement>('[data-target="strike"]')!;
    expect(strike.style.color).toBe("var(--strike-color, inherit)");
    expect(strike.style.background).toBe("var(--strike-bg, transparent)");

    // .theme-quote-text (not [data-target="quote"] — the <blockquote>
    // CONTAINER carries that same data-target too, and querySelector would
    // match it first in document order since it's the ancestor).
    const quoteText = host.querySelector<HTMLElement>(".theme-quote-text")!;
    expect(quoteText.style.color).toBe("var(--quote-color, inherit)");
    // quote's background lives on the CONTAINER, not this button (paint
    // "quote-text" only ever touches color) — the button itself must NOT
    // carry a background style, or it'd double-paint over the container.
    expect(quoteText.style.background).toBe("");

    const container = host.querySelector<HTMLElement>(".theme-quote")!;
    expect(container.style.background).toBe("var(--quote-bg, var(--block-fill))");

    const quoteBar = host.querySelector<HTMLElement>('[data-target="quoteBar"]')!;
    expect(quoteBar.style.backgroundColor).toBe("var(--quote-bar, var(--block-edge))");

    const codeBlock = host.querySelector<HTMLElement>('[data-target="codeBlock"]')!;
    expect(codeBlock.style.color).toBe("var(--codeblock-color, inherit)");
    expect(codeBlock.style.background).toBe("var(--codeblock-bg, var(--block-fill))");

    // round 3: highlightBlock paints its OWN background (paint: "block-bg" —
    // no separate text color key exists), text stays --fg.
    const highlightBlock = host.querySelector<HTMLElement>('[data-target="highlightBlock"]')!;
    expect(highlightBlock.style.background).toBe(
      "var(--highlightblock-bg, color-mix(in srgb, var(--highlight-bg) 22%, transparent))",
    );
    expect(highlightBlock.style.color).toBe("var(--fg)");
  });

  // round 2 (design decision 1, item 5 / 감사 major #3의 근본 해결): the
  // blockquote's left bar now has its OWN key (`quoteBar`) instead of riding
  // `border` — round 1's fix only demoted it to decoration; round 2 gives it
  // a real target so "클릭한 그 자리가 바뀐다" holds for it too.
  it("quote bar and quote text are separate real targets; the container itself owns 'quote' for padding clicks", () => {
    mount();
    const quoteBar = host.querySelector<HTMLElement>('[data-target="quoteBar"]')!;
    expect(quoteBar.tagName).toBe("BUTTON");
    expect(quoteBar.classList.contains("theme-quote-bar")).toBe(true);

    const quoteText = host.querySelector(".theme-quote-text")!;
    expect(quoteText.tagName).toBe("BUTTON");
    expect(quoteText.getAttribute("data-target")).toBe("quote");

    // The <blockquote> container carries data-target="quote" itself (not a
    // button) so a click on its padding — outside both inner buttons —
    // resolves to "quote" via closest(), not a false fall-through to "bg".
    const container = host.querySelector(".theme-quote")!;
    expect(container.tagName).toBe("BLOCKQUOTE");
    expect(container.getAttribute("data-target")).toBe("quote");
    expect(container.tagName).not.toBe("BUTTON");
  });

  it("clicking the quote bar selects quoteBar (innermost wins over the container's quote)", () => {
    mount();
    const quoteBar = host.querySelector<HTMLElement>('[data-target="quoteBar"]')!;
    quoteBar.click();
    expect(quoteBar.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking the quote container padding (not bar/text) selects quote, not bg", () => {
    mount();
    const container = host.querySelector<HTMLElement>(".theme-quote")!;
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(container.getAttribute("data-target")).toBe("quote");
    // reflectSelection compares dataset.target against the selected id on
    // every .theme-target — the container isn't one, so assert via the
    // paired quote-text button's aria-pressed instead (same target id).
    const quoteText = host.querySelector<HTMLElement>(".theme-quote-text")!;
    expect(quoteText.getAttribute("aria-pressed")).toBe("true");
  });

  it("codeBlock is one button covering the whole block (no internal split)", () => {
    mount();
    const block = host.querySelector<HTMLElement>('[data-target="codeBlock"]')!;
    expect(block.tagName).toBe("BUTTON");
    expect(block.textContent).toContain('const bag = pack("가볍게");');
    expect(block.textContent).toContain("bag.weigh();");
  });

  // round 3: highlightBlock mirrors codeBlock's "one button, no internal
  // split" contract, 2 body-line spans, no fence markers (EDIT_MODE_SAMPLE_TEXT
  // doc comment exception 4 — the block is atomic like codeBlock/quote).
  it("highlightBlock is one button covering the whole block, 2 body lines, no fence markers", () => {
    mount();
    const block = host.querySelector<HTMLElement>('[data-target="highlightBlock"]')!;
    expect(block.tagName).toBe("BUTTON");
    expect(block.classList.contains("theme-highlightblock")).toBe(true);
    expect(block.querySelectorAll(".theme-highlightblock-line").length).toBe(2);
    expect(block.textContent).not.toContain("```highlight");
    expect(block.textContent).not.toContain("```");
  });

  // Inspector chip: highlightBlock has NO bgKey, so no tab row — but its
  // colorKey IS an OPTIONAL_KEYS "auto" key, so the inspector still shows the
  // "자동" chip when nothing is set (generic isOptionalKey/absentKind wiring,
  // no inspector code change needed).
  it("highlightBlock has no bgKey (no background tab)", () => {
    const t = THEME_TARGETS.find((x) => x.id === "highlightBlock")!;
    expect(t.bgKey).toBeUndefined();
  });

  // The hr is the ONLY thing painted with --border now; nothing else in the
  // frame should still reference it as a text/fill color (regression guard
  // for the anchor move itself).
  it("the border target is a real button anchored to the horizontal rule", () => {
    mount();
    const hr = host.querySelector<HTMLElement>('[data-target="border"]')!;
    expect(hr.tagName).toBe("BUTTON");
    expect(hr.classList.contains("theme-hr")).toBe(true);
  });

  it("hovering a target shows its label in the single status line (never a floating chip)", () => {
    mount();
    const hint = host.querySelector<HTMLElement>(".theme-preview-hint")!;
    const defaultText = hint.textContent;

    const bold = host.querySelector<HTMLElement>('[data-target="bold"]')!;
    bold.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(hint.textContent).toBe("굵은 글자 (Bold)");

    bold.dispatchEvent(new Event("pointerout", { bubbles: true }));
    expect(hint.textContent).toBe(defaultText);
  });

  it("selecting a target sets aria-pressed and a second selection clears the first", () => {
    mount();
    const bold = host.querySelector<HTMLElement>('[data-target="bold"]')!;
    const italic = host.querySelector<HTMLElement>('[data-target="italic"]')!;

    bold.click();
    expect(bold.getAttribute("aria-pressed")).toBe("true");

    italic.click();
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    expect(italic.getAttribute("aria-pressed")).toBe("true");
  });

  it("Escape clears the current selection", () => {
    mount();
    const bold = host.querySelector<HTMLElement>('[data-target="bold"]')!;
    bold.click();
    expect(bold.getAttribute("aria-pressed")).toBe("true");

    bold.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(bold.getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking the frame margin (not a nested target) selects bg", () => {
    mount();
    const frame = host.querySelector<HTMLElement>('[data-target="bg"]')!;
    frame.click(); // jsdom: click() dispatches with target === frame itself
    expect(frame.getAttribute("aria-pressed")).toBe("true");
  });

  // 2026-08 폴리시 4차 (사용자 요청): "배경 클릭하면 배경변경 UI 활성화되잖아,
  // 그거 다시 한번 클릭하면 비활성화 토글돼야 할거같은데?" — 같은 대상을
  // 다시 누르면 선택이 해제된다. 다른 대상 클릭은 여전히 전환(위 테스트가
  // 이미 잠금).
  describe("폴리시 4차 — 재클릭 토글", () => {
    it("재클릭(같은 타깃)은 선택을 해제한다", () => {
      mount();
      const bold = host.querySelector<HTMLElement>('[data-target="bold"]')!;
      bold.click();
      expect(bold.getAttribute("aria-pressed")).toBe("true");

      bold.click(); // 재클릭 — 토글 해제
      expect(bold.getAttribute("aria-pressed")).toBe("false");
    });

    it("bg(프레임 여백) 재클릭도 토글 해제된다 — 사용자가 든 예시", () => {
      mount();
      const frame = host.querySelector<HTMLElement>('[data-target="bg"]')!;
      frame.click();
      expect(frame.getAttribute("aria-pressed")).toBe("true");

      frame.click();
      expect(frame.getAttribute("aria-pressed")).toBe("false");
    });

    it("그룹 타깃(fg)은 첫 런과 다른 런을 눌러도 재클릭으로 친다 — 같은 data-target이므로 해제된다", () => {
      mount();
      const runs = host.querySelectorAll<HTMLElement>('[data-target="fg"]');
      const focusableFgRun = Array.from(runs).find((r) => r.tagName === "BUTTON")!;
      const otherFgRun = Array.from(runs).find((r) => r !== focusableFgRun)!;

      focusableFgRun.click();
      expect(focusableFgRun.getAttribute("aria-pressed")).toBe("true");

      otherFgRun.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 다른 런, 같은 타깃
      expect(focusableFgRun.getAttribute("aria-pressed")).toBe("false");
    });

    it("다른 대상 클릭은 토글이 아니라 전환이다 — 재클릭 로직이 전환 경로를 건드리지 않았는지 확인", () => {
      mount();
      const bold = host.querySelector<HTMLElement>('[data-target="bold"]')!;
      const italic = host.querySelector<HTMLElement>('[data-target="italic"]')!;
      bold.click();
      italic.click();
      expect(bold.getAttribute("aria-pressed")).toBe("false");
      expect(italic.getAttribute("aria-pressed")).toBe("true");
    });

    it("키보드로도 동일하다 — bg에 Enter를 두 번 누르면 토글 해제된다(role=button 수동 처리 경로)", () => {
      mount();
      const frame = host.querySelector<HTMLElement>('[data-target="bg"]')!;
      frame.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(frame.getAttribute("aria-pressed")).toBe("true");

      frame.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(frame.getAttribute("aria-pressed")).toBe("false");
    });

    // "카드 자신을 클릭한 건 재클릭이 아니다" — 인스펙터 카드는 미리보기
    // wrap의 자식이 아니라 형제(controls.ts의 `cell.append(preview.el,
    // inspector.el, details)`)라서, 카드 내부 클릭은 애초에 preview의 click
    // 위임(`wrap.addEventListener`)에 잡히지 않는다. select()의 토글 로직과
    // 무관하게 이 전제가 실제 합성 DOM에서 여전히 성립하는지 직접 확인한다.
    it("카드 내부(색상 칩) 클릭은 선택을 유지한다 — 카드는 wrap의 자식이 아니다", () => {
      mount();
      const bold = host.querySelector<HTMLElement>('[data-target="bold"]')!;
      bold.click();
      expect(bold.getAttribute("aria-pressed")).toBe("true");

      const chip = host.querySelector<HTMLElement>(".theme-inspector-palette .theme-chip")!;
      expect(chip).toBeTruthy();
      chip.click();
      expect(bold.getAttribute("aria-pressed")).toBe("true"); // 카드 클릭으로 해제되면 안 됨
    });
  });

  // round-2 감사 반영, 결정 6: "일반 텍스트 색상도 선택이 안된다" — round 1의
  // 결함은 문단당 두 글자("짐은")만 fg였고, 나머지 평문은 죽은 영역이었다.
  // 이 그룹이 그 결함과 재발 방지 게이트를 담는다.
  describe("결정 6 — 평문 fg 전체 타깃화 + 죽은 영역 소거", () => {
    it("clicking ANY plain-text run in a paragraph selects fg, not just the first two syllables", () => {
      mount();
      // "잡는다." 뒤의 non-button fg run (문단 1의 두 번째 fg 조각).
      const runs = host.querySelectorAll<HTMLElement>('[data-target="fg"]');
      expect(runs.length).toBeGreaterThan(1); // more than the one focusable run
      const nonButtonRun = Array.from(runs).find((r) => r.tagName !== "BUTTON")!;
      expect(nonButtonRun).toBeTruthy();
      nonButtonRun.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const focusableFgRun = Array.from(runs).find((r) => r.tagName === "BUTTON")!;
      expect(focusableFgRun.getAttribute("aria-pressed")).toBe("true");
    });

    it("exactly one fg run per paragraph is a real <button> (one Tab stop per paragraph)", () => {
      mount();
      const paragraphs = host.querySelectorAll(".theme-p");
      expect(paragraphs.length).toBe(2);
      for (const p of Array.from(paragraphs)) {
        const fgButtons = p.querySelectorAll('button[data-target="fg"]');
        expect(fgButtons.length).toBe(1);
      }
    });

    it("no paragraph has a bare (unwrapped) non-whitespace text node — every run is under [data-target]", () => {
      mount();
      for (const p of Array.from(host.querySelectorAll(".theme-p"))) {
        for (const node of Array.from(p.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE) {
            expect(node.textContent!.trim(), `bare text node "${node.textContent}" in a paragraph`).toBe("");
          }
        }
      }
    });

    it("unclaimed clicks inside the frame (scale-strip separator, doc gaps) fall through to bg", () => {
      mount();
      const strip = host.querySelector<HTMLElement>(".theme-scale-strip")!;
      // The " · " separators are bare text nodes directly in the strip, not
      // wrapped — clicking the strip container itself (no nearer [data-target]
      // in between) is the jsdom-reachable proxy for "clicked a separator".
      strip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const frame = host.querySelector<HTMLElement>('[data-target="bg"]')!;
      expect(frame.getAttribute("aria-pressed")).toBe("true");

      frame.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      const doc = host.querySelector<HTMLElement>(".theme-doc")!;
      doc.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(frame.getAttribute("aria-pressed")).toBe("true");
    });
  });

  // round 2 decision 7: the card is hidden entirely (no DOM at all, not even
  // a "collapsed hint" row) while nothing is selected, and becomes visible
  // on selection — the document uses the full pane height when unselected.
  it("selecting a target un-hides the floating inspector with color/bg tabs", () => {
    mount();
    const inspector = host.querySelector<HTMLElement>(".theme-inspector")!;
    expect(inspector.hidden).toBe(true);

    const bold = host.querySelector<HTMLElement>('[data-target="bold"]')!;
    bold.click();

    expect(inspector.hidden).toBe(false);
    const tabs = host.querySelectorAll(".theme-inspector-tab");
    expect(tabs.length).toBe(2);
  });

  it("validates and applies theme when text JSON editing and click Apply", () => {
    mount();
    const initialTheme = themeJsonSetting.get();

    const textarea = host.querySelector(".settings-json") as HTMLTextAreaElement;
    const applyButton = host.querySelector('[data-act="apply"]') as HTMLButtonElement;
    const errorDiv = host.querySelector(".settings-json-error") as HTMLDivElement;

    textarea.value = "{ invalid json }";
    applyButton.click();
    expect(errorDiv.textContent).toBe("유효하지 않은 테마 JSON입니다.");
    expect(themeJsonSetting.get()).toEqual(initialTheme);

    const customTheme = builtInTheme("light");
    customTheme.colors.bg = "#f0f0f0";
    textarea.value = JSON.stringify(customTheme);
    applyButton.click();
    expect(errorDiv.textContent).toBe("");
    expect(themeJsonSetting.get().colors.bg).toBe("#f0f0f0");

    themeJsonSetting.set(initialTheme);
  });

  it("teardown stops the preview/inspector from reacting to further setting changes", () => {
    const rowEl = mount();
    const bold = host.querySelector<HTMLElement>('[data-target="bold"]')!;
    bold.click();
    expect(host.querySelector(".theme-inspector")!.hasAttribute("hidden")).toBe(false);

    runTeardown(rowEl);
    // After teardown, an external change must not throw and must not repopulate
    // a torn-down inspector's live bindings (no stale-DOM writes).
    expect(() => themeJsonSetting.set({ ...builtInTheme("dark") })).not.toThrow();
  });
});

describe("parseTheme backward-compat", () => {
  function legacyEightKeyJson(preset: "dark" | "light"): string {
    const t = builtInTheme(preset);
    const eight = {
      bg: t.colors.bg,
      fg: t.colors.fg,
      accent: t.colors.accent,
      link: t.colors.link,
      surface: t.colors.surface,
      border: t.colors.border,
      muted: t.colors.muted,
      highlightBg: t.colors.highlightBg,
    };
    return JSON.stringify({ ...t, colors: eight });
  }

  it("parses an old 8-key theme without rejecting it (no reset)", () => {
    const parsed = parseTheme(legacyEightKeyJson("dark"));
    expect(parsed).not.toBeNull();
    expect(parsed!.colors.bg).toBe("#131110");
    expect(parsed!.colors.fg).toBe("#ffffff");
    expect(parsed!.colors.accent).toBe("#a8c8e8");
    expect(parsed!.colors.muted).toBe("#a8a29e");
  });

  it("promotes a legacy 8-key theme to the full extended set via fallback", () => {
    // A CUSTOM name (not dark/light/claude) so upgradePristinePreset's "snap a
    // pristine built-in preset to its curated new-gen values" path can't kick
    // in — this isolates the raw EXTENDED_FALLBACK rule under test.
    const t = builtInTheme("dark");
    const eight = {
      bg: t.colors.bg, fg: t.colors.fg, accent: t.colors.accent, link: t.colors.link,
      surface: t.colors.surface, border: t.colors.border, muted: t.colors.muted, highlightBg: t.colors.highlightBg,
    };
    const parsed = parseTheme(JSON.stringify({ ...t, name: "custom-dark", colors: eight }))!;
    expect(parsed.colors.h1).toBe(parsed.colors.fg);
    expect(parsed.colors.h6).toBe(parsed.colors.muted);
    expect(parsed.colors.bold).toBe(parsed.colors.fg);
    expect(parsed.colors.italic).toBe(parsed.colors.fg);
    expect(parsed.colors.code).toBe(parsed.colors.accent);
    expect(parsed.colors.highlight).toBe("#1a1300");
    expect(parsed.colors.comment).toBe(parsed.colors.muted);
    // No background key materializes out of thin air for a legacy theme.
    expect(parsed.colors.boldBg).toBeUndefined();
  });

  it("a PRISTINE built-in preset (name=dark, no new-gen keys, unedited) upgrades to the curated comment tone instead of the naive muted fallback", () => {
    const parsed = parseTheme(legacyEightKeyJson("dark"))!;
    expect(parsed.colors.comment).toBe(builtInTheme("dark").colors.comment);
  });

  it("still strict-rejects a missing CORE key (SSOT integrity)", () => {
    const t = builtInTheme("dark");
    const broken = { ...t.colors } as Record<string, unknown>;
    delete broken.bg;
    const json = JSON.stringify({ ...t, colors: broken });
    expect(parseTheme(json)).toBeNull();
  });

  it("round-trips an 18+comment theme through serialize → parse", () => {
    const built = builtInTheme("light");
    const reparsed = parseTheme(serializeTheme(built))!;
    expect(reparsed.colors.h1).toBe(built.colors.h1);
    expect(reparsed.colors.code).toBe(built.colors.code);
    expect(reparsed.colors.highlight).toBe(built.colors.highlight);
    expect(reparsed.colors.comment).toBe(built.colors.comment);
  });
});

describe("preset sync", () => {
  beforeEach(() => {
    localStorage.clear();
    themeJsonSetting.set(builtInTheme("dark"));
  });
  afterEach(() => {
    themeJsonSetting.set(builtInTheme("dark"));
  });

  it("overwrites themeJson with the preset builtin when the name differs", () => {
    themeJsonSetting.set(builtInTheme("dark"));
    syncJsonToPreset("light");
    expect(themeJsonSetting.get().name).toBe("light");
    expect(themeJsonSetting.get().colors.bg).toBe(builtInTheme("light").colors.bg);
  });

  it("is a no-op when the name already matches (loop guard)", () => {
    themeJsonSetting.set(builtInTheme("light"));
    const spy = vi.fn();
    const unsub = themeJsonSetting.subscribe(spy);
    syncJsonToPreset("light");
    expect(spy).not.toHaveBeenCalled();
    unsub();
  });

  it("preserves user edits when re-selecting the same preset name", () => {
    const edited = { ...builtInTheme("dark"), colors: { ...builtInTheme("dark").colors, h1: "#abcdef" } };
    themeJsonSetting.set(edited);
    syncJsonToPreset("dark");
    expect(themeJsonSetting.get().colors.h1).toBe("#abcdef");
  });
});

// Part C (design §5, plan step 13): the geometry slider section sits between
// the preview frame/inspector and the JSON accordion, and read-modify-writes
// `Theme.geometry` through the SAME `Setting<Theme>` as the frame/inspector —
// no new setting, no fan-out (design §5.1/§5.2).
describe("theme geometry sliders (design §5 — Phase 2)", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    themeJsonSetting.set(builtInTheme("light"));
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    runTeardown(el());
    host.remove();
    themeJsonSetting.set(builtInTheme("light"));
  });

  let mounted: HTMLElement | null = null;
  function el(): HTMLElement {
    return mounted!;
  }
  function mount(): HTMLElement {
    const row = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    mounted = row;
    host.appendChild(row);
    return row;
  }

  function geometrySection(): HTMLElement {
    return host.querySelector(".theme-geometry")!;
  }

  function sliderRow(label: string): { input: HTMLInputElement; value: HTMLElement; chip: HTMLButtonElement } {
    const section = geometrySection();
    const input = section.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    const rowEl = input.closest(".theme-geometry-row") as HTMLElement;
    const value = rowEl.querySelector(".settings-slider-value") as HTMLElement;
    const chip = rowEl.querySelector<HTMLButtonElement>("button")!;
    return { input, value, chip };
  }

  it("sits between the preview/inspector and the JSON accordion, cell order preview→inspector→geometry→details", () => {
    const row = mount();
    const cell = row.querySelector(".settings-row-control")!;
    const kids = Array.from(cell.children);
    const geoIdx = kids.findIndex((k) => k.classList.contains("theme-geometry"));
    const detailsIdx = kids.findIndex((k) => k.tagName === "DETAILS");
    expect(geoIdx).toBeGreaterThan(-1);
    expect(detailsIdx).toBeGreaterThan(geoIdx);
    // preview frame + inspector both precede it
    expect(geoIdx).toBeGreaterThanOrEqual(2);
  });

  it("renders two slider rows (radius px, padding em) with the plan's ranges/steps", () => {
    mount();
    const radius = sliderRow("모서리 둥글기");
    expect(radius.input.type).toBe("range");
    expect(radius.input.classList.contains("settings-slider")).toBe(true);
    expect(radius.input.min).toBe("0");
    expect(radius.input.max).toBe("24");
    expect(radius.input.step).toBe("1");

    const padding = sliderRow("안쪽 여백");
    expect(padding.input.min).toBe("0");
    expect(padding.input.max).toBe("2");
    expect(padding.input.step).toBe("0.1");
  });

  it("absent geometry shows the 자동 chip pressed and '자동' as the value/aria-valuetext", () => {
    mount();
    const { input, value, chip } = sliderRow("모서리 둥글기");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(value.textContent).toBe("자동");
    expect(input.getAttribute("aria-valuetext")).toBe("자동");
  });

  it("dragging the radius slider writes geometry.blockRadius as `${n}px` and clears the auto chip", () => {
    mount();
    const { input, value, chip } = sliderRow("모서리 둥글기");
    input.value = "12";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(themeJsonSetting.get().geometry?.blockRadius).toBe("12px");
    expect(value.textContent).toBe("12px");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("dragging the padding slider writes geometry.blockPadding as `${n}em`", () => {
    mount();
    const { input, value } = sliderRow("안쪽 여백");
    input.value = "0.5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(themeJsonSetting.get().geometry?.blockPadding).toBe("0.5em");
    expect(value.textContent).toBe("0.5em");
  });

  it("clicking the auto chip deletes that geometry key; both-absent omits `geometry` from serialize", () => {
    mount();
    const { input, chip } = sliderRow("모서리 둥글기");
    input.value = "10";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(themeJsonSetting.get().geometry?.blockRadius).toBe("10px");
    chip.click();
    expect(themeJsonSetting.get().geometry?.blockRadius).toBeUndefined();
    expect(serializeTheme(themeJsonSetting.get())).not.toContain('"geometry"');
  });

  it("external theme changes (JSON apply / preset swap) reflect into the sliders (bind round-trip)", () => {
    mount();
    themeJsonSetting.set({
      ...themeJsonSetting.get(),
      geometry: { blockRadius: "16px", blockPadding: "1.2em" },
    });
    const radius = sliderRow("모서리 둥글기");
    expect(radius.input.value).toBe("16");
    expect(radius.value.textContent).toBe("16px");
    const padding = sliderRow("안쪽 여백");
    expect(padding.input.value).toBe("1.2");
    expect(padding.value.textContent).toBe("1.2em");
  });

  it("the geometry section carries no [data-target] — it doesn't participate in the frame click grammar", () => {
    mount();
    expect(geometrySection().querySelector("[data-target]")).toBeNull();
  });

  it("teardown unsubscribes the geometry sliders (no stale writes into detached DOM)", () => {
    const row = mount();
    runTeardown(row);
    mounted = document.createElement("div"); // afterEach's runTeardown(el()) becomes a no-op
    // Re-mounting a fresh set of theme values must not throw or reflect into the old (torn-down) DOM.
    expect(() =>
      themeJsonSetting.set({ ...themeJsonSetting.get(), geometry: { blockRadius: "3px" } }),
    ).not.toThrow();
  });
});

describe("subscription teardown", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    themeJsonSetting.set(builtInTheme("dark"));
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
    themeJsonSetting.set(builtInTheme("dark"));
  });

  it("attachTeardown / runTeardown round-trip runs every registered fn once", () => {
    const el = document.createElement("div");
    const a = vi.fn();
    const b = vi.fn();
    attachTeardown(el, [a, b]);
    runTeardown(el);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    runTeardown(el);
    expect(a).toHaveBeenCalledTimes(1);
  });
});
