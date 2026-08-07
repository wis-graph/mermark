import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildColorInspector, presetDefaultFor, pickInspectorEdge } from "../src/settings/panel/color-inspector";
import { themeJsonSetting } from "../src/settings/app";
import { builtInTheme, serializeTheme } from "../src/settings/theme-schema";
import { themeTarget } from "../src/settings/panel/theme-preview";
import { hexToHsl } from "../src/settings/panel/color-math";

describe("Color inspector", () => {
  let host: HTMLElement;
  let inspector: ReturnType<typeof buildColorInspector>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    themeJsonSetting.set(builtInTheme("light"));
    host = document.createElement("div");
    document.body.appendChild(host);
    onClose = vi.fn();
    inspector = buildColorInspector(themeJsonSetting, onClose);
    host.appendChild(inspector.el);
  });

  afterEach(() => {
    inspector.teardown();
    host.remove();
    themeJsonSetting.set(builtInTheme("light"));
  });

  // round-2 decision 7: no card at all while nothing is selected — the
  // "collapsed hint row" round 1 used is gone (the document gets the space).
  it("the card is entirely hidden when nothing is selected", () => {
    expect(inspector.el.hidden).toBe(true);
    expect(host.querySelector(".theme-inspector-head")).toBeNull();
  });

  it("un-hides on selection and re-hides on clear", () => {
    inspector.setTarget(themeTarget("bold")!);
    expect(inspector.el.hidden).toBe(false);
    inspector.setTarget(null);
    expect(inspector.el.hidden).toBe(true);
  });

  // round-2 decision 7 change: scrollIntoView now targets the SELECTED
  // ELEMENT (passed in as the 2nd setTarget arg), not the inspector card
  // itself (round 1's docked-card behavior) — the card floats to avoid the
  // target, so scrolling the CARD into view would defeat the point.
  it("scrolls the passed target element into view (instant, not smooth) on selection", () => {
    const fakeTargetEl = document.createElement("button");
    document.body.appendChild(fakeTargetEl);
    const spy = vi.fn();
    fakeTargetEl.scrollIntoView = spy;

    inspector.setTarget(themeTarget("bold")!, fakeTargetEl);
    expect(spy).toHaveBeenCalledWith({ behavior: "auto", block: "nearest" });

    fakeTargetEl.remove();
  });

  it("the ✕ button calls the onClose callback passed to buildColorInspector", () => {
    inspector.setTarget(themeTarget("bold")!);
    const closeBtn = host.querySelector<HTMLElement>(".theme-inspector-close")!;
    closeBtn.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("selecting bold shows the label and both tabs; selecting a core color (bg) shows no tabs", () => {
    inspector.setTarget(themeTarget("bold")!);
    expect(host.querySelector(".theme-inspector-label")!.textContent).toBe("굵은 글자 (Bold)");
    expect(host.querySelectorAll(".theme-inspector-tab").length).toBe(2);

    inspector.setTarget(themeTarget("bg")!);
    expect(host.querySelectorAll(".theme-inspector-tab").length).toBe(0);
  });

  it("clicking a palette chip writes the chip's hex to the setting, preserving name", () => {
    inspector.setTarget(themeTarget("bold")!);
    const chip = host.querySelector<HTMLElement>('.theme-chip[aria-label="블루"]')!;
    chip.click();
    expect(themeJsonSetting.get().colors.bold).toBe("#1d6fb8");
    expect(themeJsonSetting.get().name).toBe("light"); // editing never renames the preset
  });

  it("the 없음 chip on the background tab clears the key (undefined + absent from JSON)", () => {
    inspector.setTarget(themeTarget("bold")!);
    // Switch to background tab.
    (host.querySelectorAll<HTMLElement>(".theme-inspector-tab")[1]!).click();
    const chip = host.querySelector<HTMLElement>('.theme-chip[aria-label="블루"]')!;
    chip.click();
    expect(themeJsonSetting.get().colors.boldBg).toBe("#1d6fb8");

    const none = host.querySelector<HTMLElement>(".theme-chip-none")!;
    none.click();
    expect(themeJsonSetting.get().colors.boldBg).toBeUndefined();
    expect(serializeTheme(themeJsonSetting.get())).not.toContain("boldBg");
  });

  it("highlight's background tab has NO 없음/자동 chip (highlightBg is a required core key)", () => {
    inspector.setTarget(themeTarget("highlight")!);
    (host.querySelectorAll<HTMLElement>(".theme-inspector-tab")[1]!).click();
    expect(host.querySelector(".theme-chip-none")).toBeNull();
    expect(host.querySelector(".theme-chip-auto")).toBeNull();
  });

  // round 2: quote's COLOR key is itself optional (absent → "자동", inherits)
  // — design decision 2's "글자색 탭에도 칩이 생긴다". quote has no
  // background tab of its own key pair... it DOES (quoteBg), so both tabs
  // show a chip, but the CHIP KIND on both is "자동" (absentKind === "auto"),
  // never the round-1 "없음" slash-circle.
  it("quote shows a '자동' chip (not '없음') on both the color and background tab", () => {
    inspector.setTarget(themeTarget("quote")!);
    expect(host.querySelectorAll(".theme-inspector-tab").length).toBe(2); // quote has a bg pair (quoteBg)
    const colorAuto = host.querySelector<HTMLElement>(".theme-chip-auto")!;
    expect(colorAuto).toBeTruthy();
    expect(colorAuto.textContent).toBe("자동");
    expect(colorAuto.getAttribute("aria-label")).toBe("자동 (테마에서 파생)");
    expect(host.querySelector(".theme-chip-none")).toBeNull();

    (host.querySelectorAll<HTMLElement>(".theme-inspector-tab")[1]!).click(); // 배경색
    expect(host.querySelector(".theme-chip-auto")).toBeTruthy();
    expect(host.querySelector(".theme-chip-none")).toBeNull();
  });

  // quoteBar has no bg pair — single control, but its lone color key is
  // still optional ("자동", following --block-edge).
  it("quoteBar (no bg pair) shows a single '자동' control, no tabs", () => {
    inspector.setTarget(themeTarget("quoteBar")!);
    expect(host.querySelectorAll(".theme-inspector-tab").length).toBe(0);
    expect(host.querySelector(".theme-chip-auto")).toBeTruthy();
  });

  // design decision 2's "의도된 UX 개선": codeBg's absence used to render as
  // a "없음" chip even though a real fill (--surface-veil) was visible — a
  // label that lied. absentKind(codeBg) is now "auto", so the chip and hex
  // readout say "자동" instead.
  it("code's background tab shows '자동' (not '없음') — the codeBg label fix", () => {
    inspector.setTarget(themeTarget("code")!);
    (host.querySelectorAll<HTMLElement>(".theme-inspector-tab")[1]!).click();
    expect(host.querySelector(".theme-chip-auto")).toBeTruthy();
    expect(host.querySelector(".theme-chip-none")).toBeNull();
    expect(host.querySelector(".theme-inspector-hex")!.textContent).toBe("자동");
  });

  it("HSL sliders write a hex value derived from the drag, live-reflected in the hex readout", () => {
    inspector.setTarget(themeTarget("bold")!);
    const hueInput = host.querySelectorAll<HTMLInputElement>(".theme-inspector-slider-row input")[0]!;
    hueInput.value = "0";
    hueInput.dispatchEvent(new Event("input"));
    const written = themeJsonSetting.get().colors.bold!;
    expect(written).toMatch(/^#[0-9a-f]{6}$/);
  });

  // 2026-08 round-1 감사 반영 (blocker #1): color-inspector used to call the
  // structural render() (which destroys and recreates .theme-inspector-body,
  // sliders included) on EVERY color write. A real mouse drag over CDP
  // proved this breaks dragging: destroying an <input type=range> mid-drag
  // drops the browser's implicit pointer capture, so the drag died after its
  // first `input` event. This test fires a MULTI-STEP sequence (like a real
  // drag) and asserts (a) the slider element's reference never changes and
  // stays connected, and (b) the final color reflects the LAST step.
  it("a multi-step Hue drag keeps the same slider element and accumulates to the final value (regression: render() must never run mid-drag)", () => {
    inspector.setTarget(themeTarget("bold")!);
    const originalHueInput = host.querySelectorAll<HTMLInputElement>(".theme-inspector-slider-row input")[0]!;

    const dragSteps = [40, 90, 140, 190, 240, 290, 324]; // mimics 7 mousemove ticks of one drag gesture
    for (const v of dragSteps) {
      const liveHueInput = host.querySelectorAll<HTMLInputElement>(".theme-inspector-slider-row input")[0]!;
      expect(liveHueInput).toBe(originalHueInput); // never rebuilt mid-drag
      expect(liveHueInput.isConnected).toBe(true);
      liveHueInput.value = String(v);
      liveHueInput.dispatchEvent(new Event("input"));
    }

    const finalHex = themeJsonSetting.get().colors.bold!;
    const finalHue = hexToHsl(finalHex).h;
    expect(Math.abs(finalHue - 324)).toBeLessThan(6);
  });

  // round-2 감사 반영 (design decision 7, invariant B — the SAME failure
  // class as round-1's blocker #1, just at the "where does the card sit"
  // layer instead of "does the slider exist" layer): a value write must
  // NEVER reposition the card. If it did, a slider drag would visually jump
  // the card around under the pointer mid-gesture.
  it("invariant B: the card's edge class never changes across value writes (placement is setTarget-only)", () => {
    const fakeTargetEl = document.createElement("button");
    document.body.appendChild(fakeTargetEl);
    inspector.setTarget(themeTarget("bold")!, fakeTargetEl);
    const edgeAfterSelect = inspector.el.className;

    const hueInput = host.querySelectorAll<HTMLInputElement>(".theme-inspector-slider-row input")[0]!;
    for (const v of [40, 90, 140, 190]) {
      hueInput.value = String(v);
      hueInput.dispatchEvent(new Event("input"));
      expect(inspector.el.className).toBe(edgeAfterSelect); // unchanged by every write
    }
    fakeTargetEl.remove();
  });

  // 2026-08 폴리시 리뷰 2차(team-lead): fg처럼 여러 엘리먼트가 같은 target을
  // 공유할 때, 클릭된 그 엘리먼트 하나의 rect만 보고 배치를 정하면 "같은
  // 그룹의 다른 런"은 여전히 카드 밑에 파묻힐 수 있었다(캡처로 지적됨).
  // computeEdge가 클릭된 엘리먼트가 아니라 같은 data-target을 가진 모든
  // 엘리먼트의 UNION rect로 겹침을 판정하는지를, 두 엘리먼트에 서로 다른
  // (모킹된) rect를 줘서 증명한다 — 클릭된 엘리먼트 자신은 하단 카드 존과
  // 안 겹치는데도, "같은 그룹의 다른 엘리먼트"가 겹치면 edge가 top으로
  // 플립돼야 한다(클릭된 엘리먼트의 rect만 봤다면 flip이 안 일어났을 것).
  it("invariant A (정련): a group target's edge decision considers ALL same-target elements, not just the clicked one", () => {
    const pane = document.createElement("div");
    pane.className = "settings-pane";
    pane.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON() {} });
    pane.appendChild(inspector.el);
    document.body.appendChild(pane);

    // Sibling element sharing the SAME data-target as the clicked one — sits
    // where the bottom card zone would land (top 450..500), while the
    // CLICKED element itself is safely up top (top 10..40).
    const siblingRun = document.createElement("span");
    siblingRun.dataset.target = "fg";
    siblingRun.getBoundingClientRect = () => ({ top: 450, bottom: 500, left: 0, right: 100, width: 100, height: 50, x: 0, y: 450, toJSON() {} });
    document.body.appendChild(siblingRun);

    const clickedRun = document.createElement("span");
    clickedRun.dataset.target = "fg";
    clickedRun.getBoundingClientRect = () => ({ top: 10, bottom: 40, left: 0, right: 100, width: 100, height: 30, x: 0, y: 10, toJSON() {} });
    document.body.appendChild(clickedRun);
    // el.offsetHeight is 0 in jsdom regardless — pickInspectorEdge's
    // cardHeight param ends up 0, so the "bottom zone" is [paneRect.bottom -
    // 0, paneRect.bottom] = [600, 600]. To exercise the flip deterministically
    // in jsdom (no real layout), stub offsetHeight to a realistic card size.
    Object.defineProperty(inspector.el, "offsetHeight", { value: 200, configurable: true });

    inspector.setTarget(themeTarget("fg")!, clickedRun);
    expect(inspector.el.classList.contains("edge-top")).toBe(true); // flipped because of the SIBLING, not the clicked element

    pane.remove();
    siblingRun.remove();
    clickedRun.remove();
  });

  it("프리셋 기본값으로 restores presetDefaultFor's value", () => {
    inspector.setTarget(themeTarget("bold")!);
    const chip = host.querySelector<HTMLElement>('.theme-chip[aria-label="블루"]')!;
    chip.click();
    expect(themeJsonSetting.get().colors.bold).toBe("#1d6fb8");

    const resetBtn = Array.from(host.querySelectorAll<HTMLElement>(".theme-inspector-btn")).find(
      (b) => b.textContent === "프리셋 기본값으로",
    )!;
    resetBtn.click();
    expect(themeJsonSetting.get().colors.bold).toBe(presetDefaultFor(builtInTheme("light"), "bold"));
  });

  // design decision 2's autoSliderBaseline: an optional key with no stored
  // value starts its slider drag from a borrowed color (quote/codeBlock/
  // strike → fg, boldItalic → italic), not an arbitrary grey — so dragging
  // away from "자동" doesn't jump to a random hue first.
  it("프리셋 기본값으로 on an optional key (quote, currently 자동) resets it right back to 자동", () => {
    inspector.setTarget(themeTarget("quote")!);
    const resetBtn = Array.from(host.querySelectorAll<HTMLElement>(".theme-inspector-btn")).find(
      (b) => b.textContent === "프리셋 기본값으로",
    )!;
    resetBtn.click(); // no built-in preset defines `quote` → writeNone → still absent
    expect(themeJsonSetting.get().colors.quote).toBeUndefined();
    expect(host.querySelector(".theme-inspector-hex")!.textContent).toBe("자동");
  });

  it("reflects an externally-applied theme (JSON import) while a target is selected", () => {
    inspector.setTarget(themeTarget("bold")!);
    const customTheme = { ...builtInTheme("light"), colors: { ...builtInTheme("light").colors, bold: "#123456" } };
    themeJsonSetting.set(customTheme);
    expect(host.querySelector(".theme-inspector-hex")!.textContent).toBe("#123456");
  });

  it("has no HEX <input type=text> anywhere (design decision 6: no typed hex input)", () => {
    inspector.setTarget(themeTarget("bold")!);
    (host.querySelectorAll<HTMLElement>(".theme-inspector-tab")[1]!).click();
    const textInputs = host.querySelectorAll('input[type="text"]');
    expect(textInputs.length).toBe(0);
  });
});

// pickInspectorEdge: pure, jsdom-free (synthetic rects) — design decision 7's
// invariant A's decision function. Default "bottom"; flips to "top" only when
// the bottom card zone would actually overlap the target.
// 2026-08 폴리시 리뷰 2차(team-lead): 하단 존을 "팬 바닥 − 카드높이"로만 계산
// (안전 마진 없이)하면 실브라우저 실측에서 `codeBlock`(넓은 블록 타깃)이
// 실제로는 카드에 덮이는데도 "안 덮임"으로 오판됐다 — sticky의 `bottom: 12px`
// 오프셋 + 카드의 `margin-top: .8em`이 순수 산술 예측보다 카드를 더 높이
// 밀어 올리기 때문(실측 오차 ~20px). `CARD_PLACEMENT_SAFETY_PX`(40)가 그
// 오차를 흡수한다 — 아래 zone 경계는 이제 `pane.bottom - cardHeight - 40`.
describe("pickInspectorEdge (design decision 7, invariant A)", () => {
  const pane = { top: 0, bottom: 600 };
  const cardHeight = 200; // bottom zone: y ∈ [360, 600] (200 + 40 안전마진)

  it("defaults to bottom when the target is nowhere near the bottom zone", () => {
    expect(pickInspectorEdge({ top: 50, bottom: 90 }, pane, cardHeight)).toBe("bottom");
  });

  it("flips to top when the target overlaps the bottom card zone", () => {
    expect(pickInspectorEdge({ top: 450, bottom: 500 }, pane, cardHeight)).toBe("top");
  });

  it("boundary: a target ending exactly at the zone's top edge does not overlap", () => {
    expect(pickInspectorEdge({ top: 310, bottom: 360 }, pane, cardHeight)).toBe("bottom");
  });

  it("boundary: a target starting exactly at the zone's top edge overlaps", () => {
    expect(pickInspectorEdge({ top: 360, bottom: 380 }, pane, cardHeight)).toBe("top");
  });

  it("a target pinned to the very bottom of the pane (round-1 blocker scenario: muted/status line) flips to top", () => {
    expect(pickInspectorEdge({ top: 580, bottom: 600 }, pane, cardHeight)).toBe("top");
  });

  it("a target at the very top of the pane (h1) stays bottom (never overlaps the bottom zone)", () => {
    expect(pickInspectorEdge({ top: 0, bottom: 30 }, pane, cardHeight)).toBe("bottom");
  });

  // 실측으로 발견된 실제 버그의 회귀 테스트: 안전 마진 없이는 "안 겹침"으로
  // 오판됐을 rect(naive zone=[400,600] 기준으론 bottom=390이라 안 겹침) —
  // 안전 마진 적용 후 zone=[360,600]이라 390은 겹침으로 잡혀야 한다.
  it("regression: a target that naive math would call safe, but the safety margin correctly flags as overlapping", () => {
    expect(pickInspectorEdge({ top: 350, bottom: 390 }, pane, cardHeight)).toBe("top");
  });
});
