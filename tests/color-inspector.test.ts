import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildColorInspector, presetDefaultFor, pickCardPlacement, clampCardWidthToPane } from "../src/settings/panel/color-inspector";
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

  // 2026-08 폴리시 3차(team-lead 실사용 정정): 불변식 C(스크롤 없이 카드가
  // 항상 보임)가 최우선이다. `.settings-pane`의 rect는 그 컨테이너의 **내부
  // 스크롤 위치와 무관하게** 항상 "지금 화면에 보이는 그 사각형"이므로, 클릭된
  // 엘리먼트의 rect가 무엇이든(=문서를 어디까지 스크롤한 뒤 클릭했든) 카드는
  // 항상 그 pane rect 안에 완전히 들어와야 한다 — 이게 실측이 아니라
  // `position: fixed` + clamp의 조합에서 나오는 구조적 보장임을 증명한다.
  it("invariant C: whatever the clicked element's rect is (any scroll position), the card's fixed top/left always lands fully inside the pane's visible rect", () => {
    const pane = document.createElement("div");
    pane.className = "settings-pane";
    const paneRect = { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON() {} };
    pane.getBoundingClientRect = () => paneRect; // 스크롤과 무관하게 항상 이 값
    pane.appendChild(inspector.el);
    document.body.appendChild(pane);
    Object.defineProperty(inspector.el, "offsetWidth", { value: 280, configurable: true });
    Object.defineProperty(inspector.el, "offsetHeight", { value: 200, configurable: true });

    // 서로 다른 스크롤 위치에서 클릭했다고 가정한 3가지 anchor rect — pane
    // rect는 위에서 고정했으므로, 이 rect들만 바뀌는 게 "스크롤 위치가 바뀐다"
    // 는 상황을 흉내낸다.
    const scenarios = [
      { top: 10, bottom: 40, left: 0, right: 100 }, // 문서 맨 위에서 클릭
      { top: 280, bottom: 320, left: 300, right: 400 }, // 문서 중간에서 클릭
      { top: 580, bottom: 600, left: 700, right: 800 }, // 문서 맨 아래에서 클릭
    ];
    for (const anchorRect of scenarios) {
      const clickedEl = document.createElement("span");
      clickedEl.getBoundingClientRect = () => ({ ...anchorRect, width: anchorRect.right - anchorRect.left, height: anchorRect.bottom - anchorRect.top, x: anchorRect.left, y: anchorRect.top, toJSON() {} });
      document.body.appendChild(clickedEl);

      inspector.setTarget(themeTarget("fg")!, clickedEl);
      const top = parseFloat(inspector.el.style.top);
      const left = parseFloat(inspector.el.style.left);
      expect(top).toBeGreaterThanOrEqual(paneRect.top + 12);
      expect(top + 200).toBeLessThanOrEqual(paneRect.bottom - 12);
      expect(left).toBeGreaterThanOrEqual(paneRect.left + 12);
      expect(left + 280).toBeLessThanOrEqual(paneRect.right - 12);

      clickedEl.remove();
    }
    pane.remove();
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

  // 2026-08 폴리시 5차 (실앱 결함: "상세조정 os 피커 동작을 안 하네") — 원인은
  // `osInput.hidden = true`(display:none)였다: display:none 엘리먼트는
  // 스펙상 "being rendered"가 아니라서 `.click()`이 네이티브 피커를 못 연다
  // (WKWebView가 스펙대로 막고, Chromium은 관대해서 재현이 안 됐다). 고침은
  // display:none을 없애고(`.chrome-btn-label`의 clip-rect 관용구로 교체 —
  // `theme-panel.css`), `showPicker()`를 우선 시도하도록 바꾼 것.
  describe("OS 피커 (design decision 6의 '상세 조정' 탈출구)", () => {
    function osButton(): HTMLButtonElement {
      return Array.from(host.querySelectorAll<HTMLButtonElement>(".theme-inspector-btn")).find(
        (b) => b.textContent === "상세 조정… (OS 피커)",
      )!;
    }
    function osInput(): HTMLInputElement {
      return host.querySelector<HTMLInputElement>(".theme-inspector-os-input")!;
    }

    it("숨김에 display:none(hidden 속성)을 쓰지 않는다 — WKWebView에서 네이티브 피커가 안 열리는 원인이었다", () => {
      inspector.setTarget(themeTarget("bold")!);
      expect(osInput().hidden).toBe(false);
    });

    it("showPicker가 없는 환경(jsdom 포함, 구버전 WebKit과 동일 조건)에서는 .click()으로 폴백한다", () => {
      inspector.setTarget(themeTarget("bold")!);
      const input = osInput();
      expect(typeof input.showPicker).not.toBe("function"); // jsdom은 showPicker를 구현 안 함 — 폴백 경로가 실제로 exercise됨을 보장
      const clickSpy = vi.fn();
      input.click = clickSpy;
      osButton().click();
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("showPicker가 있으면 그걸 우선 호출하고 .click()은 안 쓴다", () => {
      inspector.setTarget(themeTarget("bold")!);
      const input = osInput();
      const showPickerSpy = vi.fn();
      const clickSpy = vi.fn();
      input.showPicker = showPickerSpy;
      input.click = clickSpy;
      osButton().click();
      expect(showPickerSpy).toHaveBeenCalledTimes(1);
      expect(clickSpy).not.toHaveBeenCalled();
    });

    it("OS 입력의 input 이벤트가 실제로 글자색 키에 반영·저장된다", () => {
      inspector.setTarget(themeTarget("bold")!); // 글자색 탭이 기본
      osButton().click(); // osPickerKey를 "bold"로 armed
      const input = osInput();
      input.value = "#1a2b3c";
      input.dispatchEvent(new Event("input"));
      expect(themeJsonSetting.get().colors.bold).toBe("#1a2b3c");
    });

    it("배경색 탭에서도 동일하게 반영된다 (activeKey가 탭에 따라 다른 키를 반환)", () => {
      inspector.setTarget(themeTarget("bold")!);
      (host.querySelectorAll<HTMLElement>(".theme-inspector-tab")[1]!).click(); // 배경색 탭
      osButton().click(); // osPickerKey를 "boldBg"로 armed
      const input = osInput();
      input.value = "#4a5b6c";
      input.dispatchEvent(new Event("input"));
      expect(themeJsonSetting.get().colors.boldBg).toBe("#4a5b6c");
    });
  });
});

// pickCardPlacement: pure, jsdom-free (synthetic rects) — design decision 7의
// 불변식 C > A > B 판정 함수(2026-08 폴리시 3차). 선호(A, 최선의 노력)는
// anchor 아래 → anchor 위 → 그래도 안 맞으면 clamp 중앙 순으로 시도하지만,
// **모든 경로의 최종 반환값은 항상 clamp 범위 안**이다(C, 협상 불가) —
// 이전 세대의 `pickInspectorEdge`는 "안 겹침"을 근사(안전마진)로 보장했지만
// 이 함수는 반환값 자체가 clamp의 결과라 근사가 필요 없다.
describe("pickCardPlacement (design decision 7, invariant C > A > B)", () => {
  const pane = { top: 0, bottom: 600, left: 0, right: 800 };
  const cardWidth = 280;
  const cardHeight = 200; // clamp top ∈ [12, 388], clamp left ∈ [12, 508]

  it("선호(A): places the card just below the anchor when there's room", () => {
    const p = pickCardPlacement({ top: 50, bottom: 90, left: 20, right: 120 }, pane, cardWidth, cardHeight);
    expect(p.top).toBe(90 + 12);
    expect(p.left).toBe(20);
  });

  it("선호(A): flips above the anchor when there's no room below", () => {
    const p = pickCardPlacement({ top: 550, bottom: 590, left: 20, right: 120 }, pane, cardWidth, cardHeight);
    expect(p.top).toBe(550 - cardHeight - 12);
  });

  it("불변식 C: an anchor spanning nearly the whole pane (전면 대상, fg/bg — 과거의 isFullSpanTarget 분기가 필요 없다) still lands the card fully inside the pane", () => {
    const p = pickCardPlacement({ top: 0, bottom: 600, left: 0, right: 800 }, pane, cardWidth, cardHeight);
    expect(p.top).toBeGreaterThanOrEqual(pane.top + 12);
    expect(p.top + cardHeight).toBeLessThanOrEqual(pane.bottom - 12);
  });

  it("불변식 C: clamps left so the card never spills past the pane's horizontal edges", () => {
    const pLeft = pickCardPlacement({ top: 50, bottom: 90, left: -50, right: 10 }, pane, cardWidth, cardHeight);
    expect(pLeft.left).toBe(pane.left + 12);
    const pRight = pickCardPlacement({ top: 50, bottom: 90, left: 700, right: 900 }, pane, cardWidth, cardHeight);
    expect(pRight.left).toBe(pane.right - cardWidth - 12);
  });

  // 구조적 불변식 C의 직접 증명: anchor가 무엇이든(패널보다 훨씬 크거나,
  // 음수 좌표거나) 반환값은 항상 clamp 범위 안에 있어야 한다 — 개별 시나리오가
  // 아니라 "이 함수의 출력 공간 자체"에 대한 단언이다.
  it("regression property: for ANY anchor rect, the placement is always fully inside the pane's clamp bounds (구조적 불변식 C)", () => {
    const anchors = [
      { top: 0, bottom: 30, left: 0, right: 100 },
      { top: 300, bottom: 330, left: 400, right: 500 },
      { top: 580, bottom: 600, left: 750, right: 850 },
      { top: -100, bottom: 700, left: -50, right: 900 }, // pane보다 더 큰 극단값
    ];
    for (const a of anchors) {
      const p = pickCardPlacement(a, pane, cardWidth, cardHeight);
      expect(p.top).toBeGreaterThanOrEqual(pane.top + 12);
      expect(p.top + cardHeight).toBeLessThanOrEqual(pane.bottom - 12 + 1e-9);
      expect(p.left).toBeGreaterThanOrEqual(pane.left + 12);
      expect(p.left + cardWidth).toBeLessThanOrEqual(pane.right - 12 + 1e-9);
    }
  });
});

// clampCardWidthToPane: 실브라우저 실측으로 발견된 회귀 — 패널이 카드의 CSS
// 기본 최대폭(280px)보다 좁으면(예: 창을 아주 좁게 줄인 경우) top/left clamp
// 만으로는 불변식 C를 못 지킨다. `pickCardPlacement`가 clamp에 쓰는 cardWidth
// (= `el.offsetWidth`)는 카드가 실제로 이 함수로 줄어든 뒤의 값이어야 한다.
describe("clampCardWidthToPane (invariant C, narrow-pane 회귀)", () => {
  it("충분히 넉넉한 패널에서는 CSS 기본값(빈 문자열, 280px 그대로)으로 되돌린다", () => {
    const card = document.createElement("div");
    card.style.maxWidth = "999px"; // 이전 좁은 패널의 잔여값이 남아있다고 가정
    clampCardWidthToPane(card, { left: 0, right: 800 }); // available = 800-24=776 > 280
    expect(card.style.maxWidth).toBe("");
  });

  it("패널이 280px보다 좁으면 카드의 max-width를 패널이 허용하는 폭으로 줄인다", () => {
    const card = document.createElement("div");
    clampCardWidthToPane(card, { left: 0, right: 276 }); // available = 276-24=252 < 280
    expect(card.style.maxWidth).toBe("252px");
  });

  it("패널이 카드 여백(24px)보다도 좁은 극단값에서도 음수 폭을 만들지 않는다", () => {
    const card = document.createElement("div");
    clampCardWidthToPane(card, { left: 0, right: 10 }); // available = 10-24=-14
    expect(card.style.maxWidth).toBe("0px");
  });
});
