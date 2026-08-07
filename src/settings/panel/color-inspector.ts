// The color inspector. Round 1 docked it directly under the mini frame;
// round 2 floats it (design decision 7, a user-requested reversal of round
// 1's docking choice: "색상조절하는카드를 텍스트 위로 띄우고, 텍스트 영역을
// 크게 만들어서 내용물 채우면 되는거 아냐?"). theme-preview.ts calls
// setTarget() on every selection change and this module owns everything
// downstream of that: tabs (글자색/배경색), the 8-chip palette, 3 HSL
// sliders, "프리셋 기본값으로", and the OS-picker escape hatch. NO HEX INPUT
// FIELD anywhere — design decision 6 (round 1) rejects it outright ("누가
// 그걸 외워서 입력하냐"); hex is DISPLAYED (read-only text), never typed.
//
// STRUCTURE vs VALUE (round-1 audit fix — blocker #1): `render()` REBUILDS
// the DOM and must only run when the STRUCTURE changes (which target/tab is
// active). `reflectValues()` never rebuilds anything; it only writes into
// DOM refs render() already created. Every color write goes through
// `reflectValues()`, never `render()`.
//
// PLACEMENT vs VALUE (round-2 design decision 7, invariant B): the card's
// POSITION (`placeCard`) is decided ONLY from `setTarget` — exactly like
// `render()`, position is a STRUCTURAL decision (which element is selected),
// never touched by `reflectValues()`. This is the same discipline that fixed
// blocker #1 applied to a new axis: if the card repositioned on every slider
// `input` event, a drag would visually jump/relayout under the pointer — the
// same failure CLASS as destroying the slider element mid-drag, just at the
// "where does the card sit" layer instead of "does the card exist" layer.
//
// PLACEMENT PRIORITY, invariant C > A > B (2026-08 폴리시 3차, team-lead의
// 실사용 정정 — 배포된 v0.9.27을 실제로 쓴 소감: "색상UI가 아래 있는데 스크롤
// 안해도 보이게 하려고 띄운거였는데 그걸 어기고 있다"):
//   - **C — 클릭 즉시, 카드 전체가 추가 스크롤 없이 화면에 보인다.** 협상
//     불가, 최우선. 이전 세대(`edge-top`/`edge-bottom` + `position: sticky`)는
//     카드를 **문서 흐름 안**에 뒀다 — sticky는 스크롤 컨테이너 내부에서
//     스크롤을 따라 움직이는 것이지, 뷰포트에 고정되는 게 아니다. 그래서
//     `.settings-pane`을 충분히 스크롤하면 카드가 실제로 화면 밖으로 밀려날
//     수 있었다 — "띄운 게 아니라 아래 붙어 있는 것"이라는 지적이 정확히
//     이거였다.
//   - **해법**: 카드를 `position: fixed`로 바꾼다. `.theme-inspector`와
//     `.settings-pane`(스크롤 컨테이너) 사이에 새 containing block을 만드는
//     조상이 없다(조사 확인됨) — 그래서 `position: fixed`는 항상 진짜
//     **브라우저 뷰포트** 좌표계에 앉는다. 그리고 스크롤 컨테이너 자신의
//     `getBoundingClientRect()`는 그 컨테이너의 **내부 스크롤 위치와 무관하게
//     항상 "지금 화면에 보이는 그 사각형"**을 돌려준다(스크롤 오프셋은
//     콘텐츠를 컨테이너 안에서 미는 것일 뿐, 컨테이너 자신의 화면상 박스는
//     안 움직인다). 그래서 카드를 `paneRect`(그 값) 안에 완전히 clamp하면,
//     **어떤 스크롤 위치에서 클릭했든 카드는 항상 지금 보이는 화면 안**에
//     있다 — 실측이 아니라 이 두 사실(fixed=뷰포트 좌표, paneRect=보이는
//     영역)의 조합에서 구조적으로 나오는 보장이다. `pickCardPlacement`가
//     그 clamp를 구현한다.
//   - **A(선택 요소를 안 가림)는 C가 허용하는 범위 안에서만** 지킨다 — 클램프
//     범위 안에서 클릭된 엘리먼트를 피하는 자리를 먼저 시도하고, 그 자리가
//     클램프 밖으로 나가면 clamp가 이긴다(그래서 fg/bg처럼 클릭 지점이 팬
//     전체에 가까운 "전면 대상"도 더 이상 별도 분기가 필요 없다 — 피할 자리가
//     없으면 그냥 clamp 범위 안에 앉는다, 그게 곧 "클릭 지점 근처"다).
//   - **B(드래그 중 위치 고정)는 그대로** — `placeCard`는 여전히 `setTarget`
//     에서만 호출된다.
import type { Setting } from "../store";
import { absentKind, builtInTheme, isOptionalKey, type PresetName, type Theme } from "../theme-schema";
import { hexToHsl, hslToHex } from "./color-math";
import { hasBackgroundTab, type ThemeTarget } from "./theme-preview";

type Tab = "color" | "bg";
/** 카드를 `position: fixed`로 앉힐 뷰포트 좌표 — `pickCardPlacement`의 반환
 *  타입(불변식 C, 위 모듈 doc comment). */
export interface CardPlacement {
  top: number;
  left: number;
}

// The curated 6: ink, stone, blue, coral, green, amber — one fixed set that
// reads fine against all three built-in presets (design decision 6.1), not
// re-derived per theme.
const CURATED: readonly { hex: string; name: string }[] = [
  { hex: "#0c0a09", name: "잉크" },
  { hex: "#57534e", name: "스톤" },
  { hex: "#1d6fb8", name: "블루" },
  { hex: "#cc785c", name: "코랄" },
  { hex: "#2f6b4f", name: "그린" },
  { hex: "#b8722e", name: "앰버" },
];

/** Normalize any CSS color token a Theme might legitimately hold (a built-in
 *  preset's `border: rgba(255,255,255,.12)` on dark, for instance) into
 *  '#rrggbb' so hexToHsl never receives a non-hex string. Distinct from
 *  color-math's hexToHsl/hslToHex (which assume hex in/out) — this is the
 *  inspector's own "make anything hex-shaped" step, since color-math is the
 *  shared math primitive, not a display-formatting one. Pure query. */
function toDisplayHex(color: string): string {
  const c = color.trim().toLowerCase();
  if (c.startsWith("#")) {
    if (c.length === 4) return "#" + [1, 2, 3].map((i) => c[i] + c[i]).join("");
    if (c.length >= 7) return c.slice(0, 7);
  }
  const nums = c.match(/[\d.]+/g);
  if (nums && nums.length >= 3) {
    const byte = (n: string) => Math.min(255, Math.max(0, Math.round(Number(n)))).toString(16).padStart(2, "0");
    return `#${byte(nums[0]!)}${byte(nums[1]!)}${byte(nums[2]!)}`;
  }
  return "#000000";
}

/** "This target's color, under the CURRENT preset, before any user edit" —
 *  the "프리셋 기본값으로" button's target value and (for round-1 keys) a
 *  slider baseline while a background key reads as 없음. A custom
 *  (non-builtin) theme name falls back to the light preset's value — a
 *  neutral default rather than throwing, since a customized theme has no
 *  "its own" preset to read back. No built-in preset defines any of the
 *  round-1 OR round-2 optional keys, so this is always undefined for them —
 *  that's WHY `resetToPresetDefault` naturally becomes "복귀 자동/없음" for
 *  every optional key with zero extra branching. Pure query. */
export function presetDefaultFor(theme: Theme, key: keyof Theme["colors"]): string | undefined {
  const presetName: PresetName = theme.name === "dark" || theme.name === "light" || theme.name === "claude" ? theme.name : "light";
  return builtInTheme(presetName).colors[key];
}

// "자동" 상태 슬라이더가 어느 색에서 출발할지 — 실제 파생값(--block-fill 등의
// color-mix() 결과)을 TS로 재계산하지 않는다(theme-schema.ts의 resolveOptional
// doc comment와 같은 이유: 그러면 색-mix 공식의 두 번째 출처가 생긴다). 그저
// "이 키가 자동일 때 드래그를 시작할 그럴듯한 색"을 하나씩 정한 것 — 텍스트
// 색은 fg/italic처럼 실제로 상속·추종하는 값을, 배경류(quoteBg/quoteBar/
// codeBlockBg)는 빌려올 텍스트색 대응물이 없어 이 표에 없다(→ #808080 경로).
const AUTO_SLIDER_BASELINE_KEY: Partial<Record<string, keyof Theme["colors"]>> = {
  quote: "fg",
  codeBlock: "fg",
  strike: "fg",
  boldItalic: "italic",
};

/** "자동 상태 슬라이더의 근사 시작색" (순수 쿼리, design decision 2). Pure
 *  query — NOT the real derived value, just a reasonable slider baseline. */
function autoSliderBaseline(theme: Theme, key: keyof Theme["colors"]): string | undefined {
  const borrowKey = AUTO_SLIDER_BASELINE_KEY[key];
  return borrowKey ? theme.colors[borrowKey] : undefined;
}

/** Read `key`'s stored value off `theme`, or undefined if unset/blank — the
 *  "없음"/"자동" state for an optional key. Pure query. */
function storedValue(theme: Theme, key: keyof Theme["colors"]): string | undefined {
  const v = theme.colors[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** "이 키가 지금 부재 상태이고, 부재가 무엇을 뜻하는가" (순수 쿼리) — `null`
 *  이면 값이 있거나 아예 옵셔널 키가 아니다(부재 표시 대상이 아님). 인스펙터
 *  전체(dot·hex·팔레트 칩)가 이 하나의 판정을 공유해 "없음"과 "자동"이 서로
 *  다른 곳에서 다르게 갈리는 일이 없다. */
function absentStateOf(theme: Theme, key: keyof Theme["colors"]): "none" | "auto" | null {
  if (!isOptionalKey(key)) return null;
  if (storedValue(theme, key) !== undefined) return null;
  return absentKind(key);
}

/** 카드와 패널 가장자리 사이에 남기는 최소 여백 — 이전 세대의 sticky
 *  `bottom: 12px`/`top: 12px`와 **같은 값을 재사용**한 것(새 매직넘버가
 *  아니다: 감사에서 지적받았던 `CARD_PLACEMENT_SAFETY_PX`의 전례를 피하려고
 *  기존에 이미 근거가 있던 값을 그대로 가져왔다). */
const CARD_EDGE_MARGIN_PX = 12;

/** `theme-panel.css`의 `.theme-inspector { max-width: 280px }`와 반드시 같은
 *  값 — `clampCardWidthToPane`이 "패널이 이 기본폭보다 좁은가"를 판정하는
 *  기준선이다. */
const CARD_CSS_MAX_WIDTH_PX = 280;

/** 패널이 카드의 CSS 기본폭(280px)보다 좁으면, top/left clamp만으로는
 *  불변식 C를 못 지킨다 — 카드 자체가 패널보다 넓으면 오른쪽이 반드시 넘친다
 *  (실측으로 발견: 모달을 강제로 480px까지 좁혔을 때 패널 폭이 276px가 되며
 *  카드 오른쪽이 34px 넘쳤다). 그래서 배치를 계산하기 **전에** 카드 자신의
 *  렌더 폭을 패널이 허용하는 만큼으로 줄인다 — 패널이 넓으면(대부분의 실사용
 *  창 크기) CSS 기본값으로 그냥 되돌린다. `computePlacement`가 `el.offsetWidth`
 *  를 읽기 **전에** 호출해야 그 측정값이 줄어든 폭을 반영한다. Command/CQS:
 *  void. */
export function clampCardWidthToPane(cardEl: HTMLElement, paneRect: { left: number; right: number }): void {
  const available = paneRect.right - paneRect.left - 2 * CARD_EDGE_MARGIN_PX;
  cardEl.style.maxWidth = available < CARD_CSS_MAX_WIDTH_PX ? `${Math.max(available, 0)}px` : "";
}

/** "패널의 지금 보이는 영역 안에서, 카드가 앉을 자리" (순수 쿼리, design
 *  decision 7 — 불변식 C > A > B, 2026-08 폴리시 3차). `paneRect`는 스크롤
 *  컨테이너(`.settings-pane`) 자신의 rect다 — 그 컨테이너의 **내부 스크롤
 *  위치와 무관하게** 늘 "지금 화면에 보이는 그 사각형"을 가리키므로(스크롤은
 *  콘텐츠를 컨테이너 안에서 밀 뿐, 컨테이너 자신의 화면상 박스는 안 움직인다),
 *  반환값을 `position: fixed`로 그대로 쓰면 **clamp 하나만으로 "카드가 항상
 *  뷰포트 안에 있다"(불변식 C)가 구조적으로 보장**된다 — 실측으로 맞춰야 하는
 *  근사가 아니다.
 *
 *  `anchorRect`는 카드가 "피하려고 시도할" 자리(클릭/선택된 엘리먼트의 rect) —
 *  아래(anchor.bottom) → 위(anchor.top) 순으로 시도하고, 둘 다 clamp 범위
 *  밖이면(대상이 패널 높이 전체에 가까운 "전면 대상"이라 피할 자리가 없는
 *  경우 — 과거 세대의 `isFullSpanTarget` 분기가 여기로 흡수됐다: clamp가
 *  이겨서 그냥 clamp 범위 안에 앉으므로 별도 분기가 필요 없다) clamp 범위의
 *  중앙에 둔다. 어느 경로든 **마지막엔 항상 clamp가 이긴다** — 이게 A가 C보다
 *  절대 우선하지 않는다는 뜻이다. Pure query. */
export function pickCardPlacement(
  anchorRect: { top: number; bottom: number; left: number; right: number },
  paneRect: { top: number; bottom: number; left: number; right: number },
  cardWidth: number,
  cardHeight: number,
): CardPlacement {
  const minTop = paneRect.top + CARD_EDGE_MARGIN_PX;
  const maxTop = Math.max(minTop, paneRect.bottom - cardHeight - CARD_EDGE_MARGIN_PX);
  const minLeft = paneRect.left + CARD_EDGE_MARGIN_PX;
  const maxLeft = Math.max(minLeft, paneRect.right - cardWidth - CARD_EDGE_MARGIN_PX);

  let top = anchorRect.bottom + CARD_EDGE_MARGIN_PX;
  if (top > maxTop) top = anchorRect.top - cardHeight - CARD_EDGE_MARGIN_PX;
  if (top < minTop || top > maxTop) top = (minTop + maxTop) / 2; // 피할 자리 없음 — clamp 중앙
  top = Math.min(Math.max(top, minTop), maxTop);

  const left = Math.min(Math.max(anchorRect.left, minLeft), maxLeft);

  return { top, left };
}

export interface ColorInspector {
  el: HTMLElement;
  /** Command/CQS: void. Called by theme-preview's onSelect with the newly
   *  selected target and the specific DOM element the selection came from
   *  (used to scroll-into-view + measure for placement — see the module doc
   *  comment's PLACEMENT vs VALUE split). `targetEl` is omitted on clear. */
  setTarget(t: ThemeTarget | null, targetEl?: HTMLElement): void;
  teardown(): void;
}

/** Build the floating inspector. `setting` is the SAME themeJsonSetting the
 *  frame's CSS vars are sourced from — every write here goes through
 *  setting.set, never a direct CSS var write, so the frame (which paints via
 *  var(--x)) picks up the change through the existing themeVarsSink path,
 *  not a second one. `onClose` fires when the card's own ✕ button is
 *  clicked — the inspector doesn't own selection state (theme-preview.ts
 *  does), so closing routes back through the caller's clearSelection. */
export function buildColorInspector(setting: Setting<Theme>, onClose: () => void): ColorInspector {
  const el = document.createElement("div");
  el.className = "theme-inspector";
  el.hidden = true; // round-2 decision 7: no card at all while nothing is selected

  let target: ThemeTarget | null = null;
  let tab: Tab = "color";
  // A one-shot bridge to the hidden native color input: openOsPicker arms it
  // for the CURRENTLY active key, so its own `input` handler (registered
  // once, outside render()) always writes to whichever key was active when
  // the OS dialog was opened, even though render() rebuilds the DOM around it.
  let osPickerKey: keyof Theme["colors"] | null = null;

  // Live DOM refs the STRUCTURAL render() assigns and reflectValues() reads.
  // null whenever nothing is selected.
  let dotEl: HTMLElement | null = null;
  let hexEl: HTMLElement | null = null;
  let optionalChip: HTMLButtonElement | null = null; // "없음" OR "자동" — never both (absentKind picks one)
  let defaultChip: HTMLButtonElement | null = null;
  let curatedChips: HTMLButtonElement[] = [];
  let sliderH: HTMLInputElement | null = null;
  let sliderS: HTMLInputElement | null = null;
  let sliderL: HTMLInputElement | null = null;

  // "숨김"이지만 `hidden`(= display:none)은 절대 안 쓴다 — display:none인
  // 엘리먼트는 스펙상 "being rendered"가 아니라서 `.click()`/`showPicker()`가
  // 네이티브 색 피커를 못 띄운다. Chromium은 관대하게 열어주지만 WKWebView는
  // 스펙대로 막는다(실앱 실측: "상세 조정 버튼이 아무 반응이 없다" — 결함
  // 재현 확인, `_workspace/02_panel2_changes.md` "OS 피커" 절). `.chrome-btn-label`
  // 이 이미 쓰는 clip-rect 관용구(styles.css:922)로 바꾼다 — 새 방식을
  // 발명하지 않는다. 그 클래스는 시각적으로만 숨기고 엘리먼트는 "렌더링된"
  // 상태로 남긴다.
  const osInput = document.createElement("input");
  osInput.type = "color";
  osInput.className = "theme-inspector-os-input";
  const onOsInput = () => {
    if (osPickerKey) writeColor(osPickerKey, osInput.value);
  };
  osInput.addEventListener("input", onOsInput);
  el.appendChild(osInput);

  function activeKey(): keyof Theme["colors"] | null {
    if (!target) return null;
    return tab === "bg" ? (target.bgKey ?? null) : target.colorKey;
  }

  /** The hex a slider drag should start from RIGHT NOW — always read fresh
   *  off the live setting, never a snapshot captured at render() time. This
   *  is what makes a slider's own drag handler see the PREVIOUS drag step's
   *  write (steps 2..N of one gesture aren't operating on stale H/S/L).
   *  Pure query. */
  function currentBaselineHex(key: keyof Theme["colors"]): string {
    const theme = setting.get();
    const value = storedValue(theme, key);
    if (value !== undefined) return toDisplayHex(value);
    const auto = autoSliderBaseline(theme, key);
    return toDisplayHex(auto ?? presetDefaultFor(theme, key) ?? "#808080");
  }

  // Command/CQS: void. Writes never call render() — only reflectValues(),
  // via the setting.subscribe below. Writing a color changes what the
  // controls SHOW, never which controls EXIST (nor where the card sits —
  // see the module doc comment's PLACEMENT vs VALUE split), so no rebuild
  // and no reposition is warranted.
  function writeColor(key: keyof Theme["colors"], value: string): void {
    const cur = setting.get();
    setting.set({ ...cur, colors: { ...cur.colors, [key]: value } });
  }

  function writeNone(key: keyof Theme["colors"]): void {
    const cur = setting.get();
    const nextColors = { ...cur.colors } as Record<string, unknown>;
    delete nextColors[key]; // absent key = 없음/자동 (absentKind picks which)
    setting.set({ ...cur, colors: nextColors as Theme["colors"] });
  }

  function resetToPresetDefault(): void {
    const key = activeKey();
    if (!key) return;
    const dflt = presetDefaultFor(setting.get(), key);
    if (dflt === undefined) writeNone(key);
    else writeColor(key, dflt);
  }

  /** "이 입력의 네이티브 UI를 여는 방법" (순수 쿼리 아님 — 부수효과가 목적인
   *  커맨드지만, 표준 API를 우선하고 없으면 폴백한다는 판단 자체를 이름으로
   *  약속한다). `showPicker()`는 표준(2023+ 대부분 엔진 지원)이고 의도가
   *  명시적이라 우선한다 — 지원 안 하는 구버전 WebKit을 위해 `.click()`
   *  폴백을 남긴다(과거엔 이것만 있었고, display:none 시절에는 그마저도
   *  안 열렸다 — 위 osInput 선언부 주석 참조). 둘 다 사용자 제스처
   *  컨텍스트(버튼 클릭 핸들러) 안에서 호출되므로 브라우저의 gesture 요구
   *  조건은 이미 충족된다. */
  function openNativeColorPicker(input: HTMLInputElement): void {
    if (typeof input.showPicker === "function") input.showPicker();
    else input.click();
  }

  function openOsPicker(): void {
    const key = activeKey();
    if (!key) return;
    osPickerKey = key;
    osInput.value = toDisplayHex(currentBaselineHex(key));
    openNativeColorPicker(osInput);
  }

  /** Update every live control to match the CURRENT setting value, without
   *  creating/removing a single DOM node and without touching the card's
   *  position. Safe to call from the middle of an active slider drag (see
   *  module doc comment) — and safe to call when no structural body exists
   *  yet (all refs null → every branch below is a no-op). Command/CQS: void. */
  function reflectValues(): void {
    if (!target) return;
    const key = activeKey();
    if (!key) return;
    const theme = setting.get();
    const value = storedValue(theme, key);
    const absent = absentStateOf(theme, key); // "none" | "auto" | null
    const displayHex = value !== undefined ? toDisplayHex(value) : undefined;
    const dflt = presetDefaultFor(theme, key);

    if (dotEl) {
      dotEl.style.background = absent ? "transparent" : `var(${tab === "bg" ? target.bgVar : target.colorVar})`;
      dotEl.classList.toggle("is-none", absent === "none");
      dotEl.classList.toggle("is-auto", absent === "auto");
    }
    if (hexEl) hexEl.textContent = absent === "none" ? "없음" : absent === "auto" ? "자동" : (displayHex ?? "");
    if (optionalChip) optionalChip.setAttribute("aria-pressed", String(absent !== null));
    if (defaultChip) defaultChip.setAttribute("aria-pressed", String(absent === null && value === dflt));
    for (const chip of curatedChips) {
      const hex = chip.dataset.hex!;
      chip.setAttribute("aria-pressed", String(absent === null && value?.toLowerCase() === hex));
    }

    const baselineHex = displayHex ?? toDisplayHex(autoSliderBaseline(theme, key) ?? dflt ?? "#808080");
    const hsl = hexToHsl(baselineHex);
    if (sliderH) sliderH.value = String(Math.round(hsl.h));
    if (sliderS) sliderS.value = String(Math.round(hsl.s));
    if (sliderL) sliderL.value = String(Math.round(hsl.l));
  }

  /** STRUCTURAL rebuild: which controls exist for the current (target, tab).
   *  Called ONLY from setTarget() and a tab-switch click — never from a
   *  color write. Ends by calling reflectValues() once, so the freshly built
   *  controls start out showing the right values. When `target` is null the
   *  body is simply emptied — round 2 hides the whole card (`el.hidden`) in
   *  that state, so there's no "collapsed hint" content to build here
   *  anymore (that was round 1's docked-card behavior). */
  function render(): void {
    el.querySelectorAll(".theme-inspector-body").forEach((n) => n.remove());
    dotEl = null;
    hexEl = null;
    optionalChip = null;
    defaultChip = null;
    curatedChips = [];
    sliderH = null;
    sliderS = null;
    sliderL = null;

    if (!target) return;

    const body = document.createElement("div");
    body.className = "theme-inspector-body";

    const key = activeKey()!;
    const showTabs = hasBackgroundTab(target);

    const head = document.createElement("div");
    head.className = "theme-inspector-head";
    dotEl = document.createElement("span");
    dotEl.className = "theme-inspector-dot";
    const labelEl = document.createElement("span");
    labelEl.className = "theme-inspector-label";
    labelEl.textContent = target.label;
    hexEl = document.createElement("span");
    hexEl.className = "theme-inspector-hex";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "theme-inspector-close";
    closeBtn.setAttribute("aria-label", "닫기");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", onClose);
    head.append(dotEl, labelEl, hexEl, closeBtn);
    body.appendChild(head);

    if (showTabs) {
      const tabs = document.createElement("div");
      tabs.className = "theme-inspector-tabs";
      tabs.setAttribute("role", "tablist");
      const mkTab = (id: Tab, label: string) => {
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "tab");
        b.className = "theme-inspector-tab";
        b.setAttribute("aria-selected", String(tab === id));
        b.textContent = label;
        b.addEventListener("click", () => {
          tab = id; // structural: the control SET differs between tabs (없음/자동 chip, key)
          render();
        });
        return b;
      };
      tabs.append(mkTab("color", "글자색"), mkTab("bg", "배경색"));
      body.appendChild(tabs);
    }

    const palette = document.createElement("div");
    palette.className = "theme-inspector-palette";

    // "없음"/"자동" chip: exactly one of the two, and only when this key CAN
    // express absence (`isOptionalKey`) — round 2 generalizes this off the
    // tab entirely (a color-tab key can now be optional too: quote/codeBlock/
    // strike/boldItalic). Presence depends only on (key)'s own optionality —
    // structural for the lifetime of this render, never toggled by
    // reflectValues(). Which of the two chip KINDS renders is `absentKind`'s
    // job, read once here (also structural — a key's absentKind never
    // changes at runtime).
    if (isOptionalKey(key)) {
      const kind = absentKind(key);
      optionalChip = document.createElement("button");
      optionalChip.type = "button";
      optionalChip.className = kind === "none" ? "theme-chip theme-chip-none" : "theme-chip theme-chip-auto";
      if (kind === "auto") optionalChip.textContent = "자동";
      optionalChip.setAttribute("aria-label", kind === "none" ? "배경 없음" : "자동 (테마에서 파생)");
      optionalChip.addEventListener("click", () => writeNone(key));
      palette.appendChild(optionalChip);
    }

    // presetDefaultFor(key)'s definedness depends only on `key` (every
    // core/extended color key is always defined by every built-in preset; no
    // built-in preset defines any OPTIONAL_KEYS entry, round 1 or round 2) —
    // stable for the lifetime of this structural render.
    const dflt = presetDefaultFor(setting.get(), key);
    if (dflt !== undefined) {
      defaultChip = document.createElement("button");
      defaultChip.type = "button";
      defaultChip.className = "theme-chip theme-chip-default";
      defaultChip.style.background = dflt;
      defaultChip.setAttribute("aria-label", "프리셋 기본값");
      defaultChip.addEventListener("click", () => writeColor(key, dflt));
      palette.appendChild(defaultChip);
    }

    curatedChips = CURATED.map((c) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "theme-chip";
      chip.style.background = c.hex;
      chip.dataset.hex = c.hex;
      chip.setAttribute("aria-label", c.name);
      chip.addEventListener("click", () => writeColor(key, c.hex));
      palette.appendChild(chip);
      return chip;
    });
    body.appendChild(palette);

    const sliders = document.createElement("div");
    sliders.className = "theme-inspector-sliders";
    // Each slider reads the CURRENT color fresh (currentBaselineHex) on
    // every `input` event — never a value captured once at render() time —
    // so step 2..N of one drag gesture builds on step 1's write instead of
    // replaying a stale H/S/L snapshot. Combined with never rebuilding this
    // element mid-drag, this is what makes multi-step dragging accumulate.
    const mkSlider = (label: string, min: number, max: number, component: "h" | "s" | "l"): HTMLInputElement => {
      const row = document.createElement("label");
      row.className = "theme-inspector-slider-row";
      const span = document.createElement("span");
      span.textContent = label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = "1";
      input.addEventListener("input", () => {
        const hsl = hexToHsl(currentBaselineHex(key));
        const next = { ...hsl, [component]: Number(input.value) };
        writeColor(key, hslToHex(next));
      });
      row.append(span, input);
      sliders.appendChild(row);
      return input;
    };
    sliderH = mkSlider("색조 H", 0, 360, "h");
    sliderS = mkSlider("채도 S", 0, 100, "s");
    sliderL = mkSlider("밝기 L", 0, 100, "l");
    body.appendChild(sliders);

    const actions = document.createElement("div");
    actions.className = "theme-inspector-actions";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "theme-inspector-btn";
    resetBtn.textContent = "프리셋 기본값으로";
    resetBtn.addEventListener("click", resetToPresetDefault);
    const osBtn = document.createElement("button");
    osBtn.type = "button";
    osBtn.className = "theme-inspector-btn";
    osBtn.textContent = "상세 조정… (OS 피커)";
    osBtn.addEventListener("click", openOsPicker);
    actions.append(resetBtn, osBtn);
    body.appendChild(actions);

    el.appendChild(body);
    reflectValues(); // populate the just-built controls with the current value
  }

  /** Command/CQS: void. Writes the card's fixed-viewport top/left. Called
   *  ONLY from setTarget (see module doc comment, invariant B) —
   *  reflectValues() must never call this. */
  function placeCard(p: CardPlacement): void {
    el.style.top = `${p.top}px`;
    el.style.left = `${p.left}px`;
  }

  /** "지금 보이는 패널 영역 안에서, 선택된 엘리먼트를 피해 앉을 자리" —
   *  `pickCardPlacement`(불변식 C > A > B, 위 모듈 doc comment)에 이 프레임의
   *  스크롤 컨테이너(`.settings-pane`) rect와 카드의 실제 렌더 크기를 먹인다.
   *  `targetEl`이 없으면(방어적 기본값) 패널 rect 자신을 anchor로 써 clamp
   *  범위 중앙에 앉힌다. jsdom에서는 모든 rect가 0이라 top/left가 항상
   *  안정적인 상수로 떨어진다 — 실제 배치 검증은 실브라우저에서 한다. */
  function computePlacement(targetEl: HTMLElement | null): CardPlacement {
    const pane = el.closest<HTMLElement>(".settings-pane") ?? document.documentElement;
    const paneRect = pane.getBoundingClientRect();
    const anchor = targetEl?.getBoundingClientRect() ?? paneRect;
    clampCardWidthToPane(el, paneRect); // offsetWidth 측정 전에 — 줄어든 폭이 반영되게
    return pickCardPlacement(anchor, paneRect, el.offsetWidth, el.offsetHeight);
  }

  function setTarget(t: ThemeTarget | null, targetEl?: HTMLElement): void {
    target = t;
    tab = "color"; // structural: switching targets always lands on the color tab
    render();
    if (!t) {
      el.hidden = true; // round-2 decision 7: no card at all while nothing is selected
      return;
    }
    el.hidden = false;
    // 키보드 Tab 이동으로 화면 밖 타깃에 포커스가 갈 수 있으므로 그 엘리먼트를
    // 보이게는 스크롤한다(접근성 목적일 뿐 — 카드가 뷰포트 안에 있다는
    // 불변식 C는 이제 scrollIntoView와 무관하게 `position: fixed` + clamp로
    // 구조적으로 보장되므로, "카드 존을 피해 스크롤"할 필요가 없어졌다).
    // Instant(not smooth)로 다음 rect 측정이 최종 스크롤 위치를 보게 한다.
    targetEl?.scrollIntoView?.({ behavior: "auto", block: "nearest" });
    placeCard(computePlacement(targetEl ?? null));
  }

  render();
  // The SOLE reaction to every color write (this inspector's own writes AND
  // any external one — JSON apply, preset switch): reflect values in place.
  // Never render() or placeCard() here — a write never changes which
  // controls exist, nor where the card sits.
  const unsubscribe = setting.subscribe(() => {
    reflectValues();
  });

  return {
    el,
    setTarget,
    teardown() {
      unsubscribe();
      osInput.removeEventListener("input", onOsInput);
    },
  };
}
