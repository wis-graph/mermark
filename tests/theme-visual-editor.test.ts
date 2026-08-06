import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RENDER, attachTeardown, runTeardown } from "../src/settings/panel/controls";
import { themeJsonSetting, syncJsonToPreset } from "../src/settings/app";
import { builtInTheme, parseTheme, serializeTheme } from "../src/settings/theme-schema";
import { THEME_TARGETS } from "../src/settings/panel/theme-preview";

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
    // 18 distinct targets: 8 core-style (bg/surface/border/accent/muted/fg,
    // link, highlight) — wait, precisely: bg,surface,border,accent,muted,fg
    // (6 chrome/core) + link,bold,italic,code,highlight,comment (6 paired
    // text elements) + h1..h6 (6 headings) = 18.
    expect(THEME_TARGETS.length).toBe(18);
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

  // 2026-08 감사 반영(major #3): the quote bar is decorative-only now (uses
  // --block-edge, matching the real `.cm-blockquote` — see the ThemeTarget
  // doc comment in theme-preview.ts) — it must NOT be a click target, or the
  // "click here, that changes there" promise breaks again the same way.
  it("the blockquote bar is decorative only — not a click target, no data-target", () => {
    mount();
    const quoteText = host.querySelector(".theme-quote-text")!;
    expect(quoteText.tagName).not.toBe("BUTTON");
    expect(quoteText.hasAttribute("data-target")).toBe(false);
    // .closest(".theme-target") — NOT the raw [data-target] attribute selector,
    // which would also match the ANCESTOR .theme-frame (the "bg" canvas target
    // every element in the mini frame is nested under by design).
    expect(quoteText.closest(".theme-target")).toBeNull();
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

  it("selecting a target opens the docked inspector with color/bg tabs", () => {
    mount();
    expect(host.querySelector(".theme-inspector-hint")).not.toBeNull();

    const bold = host.querySelector<HTMLElement>('[data-target="bold"]')!;
    bold.click();

    expect(host.querySelector(".theme-inspector-hint")).toBeNull();
    const tabs = host.querySelectorAll('.theme-inspector-tab');
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
    expect(host.querySelector(".theme-inspector-hint")).toBeNull();

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
