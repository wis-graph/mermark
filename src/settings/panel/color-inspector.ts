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
// POSITION (`placeInspector`, sticky top/bottom) is decided ONLY from
// `setTarget` — exactly like `render()`, position is a STRUCTURAL decision
// (which element is selected), never touched by `reflectValues()`. This is
// the same discipline that fixed blocker #1 applied to a new axis: if the
// card repositioned on every slider `input` event, a drag would visually
// jump/relayout under the pointer — the same failure CLASS as destroying the
// slider element mid-drag, just at the "where does the card sit" layer
// instead of "does the card exist" layer.
import type { Setting } from "../store";
import { absentKind, builtInTheme, isOptionalKey, type PresetName, type Theme } from "../theme-schema";
import { hexToHsl, hslToHex } from "./color-math";
import { hasBackgroundTab, type ThemeTarget } from "./theme-preview";

type Tab = "color" | "bg";
export type InspectorEdge = "top" | "bottom";

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

/** CSS의 `bottom: 12px`(sticky 오프셋) + `.theme-inspector`의 `margin-top:
 *  .8em`이 실제 렌더된 카드 rect를 "팬 바닥 − 카드높이"라는 순수 산술 예측보다
 *  더 높이(더 이른 y좌표) 밀어 올린다 — 2026-08 폴리시 리뷰 2차에서 실측으로
 *  드러난 사실: `codeBlock`처럼 넓은 블록 타깃에서 이 오차(~20px)가 "겹침
 *  없음"으로 오판되게 했다(카드가 실제로는 대상의 아래쪽 몇 픽셀을 덮었는데도
 *  edge가 "bottom"에 머묾). sticky 오프셋·마진·서브픽셀 라운딩을 낱낱이
 *  재현하는 대신, 그 오차를 전부 삼키고도 남을 **여유 마진**을 판정 쪽에서
 *  보수적으로 넣는다 — 이 값만큼 존을 일찍 시작해 "약간 덜 필요한데도 flip"
 *  쪽으로 치우치게 한다(불변식 A는 안전이 우선이라, 과잉 flip이 누락된
 *  overlap보다 훨씬 싸다). */
const CARD_PLACEMENT_SAFETY_PX = 40;

/** "카드가 선택 요소를 피해 앉는 자리" (순수 쿼리, design decision 7). 기본은
 *  "bottom"(팬 하단, sticky) — 대상의 rect가 그 하단 카드 존(팬 하단에서
 *  `cardHeight + CARD_PLACEMENT_SAFETY_PX`만큼)과 겹치면 "top"으로 플립한다.
 *  `targetRect`/`paneRect`는 DOMRect 모양의 순수 객체(jsdom 없이도 테스트
 *  가능 — 합성 rect를 그대로 먹인다). 호출자는 이 함수를 부르기 **전에** 대상을
 *  스크롤로 노출시켜야 한다(카드 존을 피해 착지하도록 CSS `scroll-margin`이
 *  이미 걸려 있다 — `theme-panel.css`의 `.theme-target, .theme-frame`).
 *  Pure query. */
export function pickInspectorEdge(
  targetRect: { top: number; bottom: number },
  paneRect: { top: number; bottom: number },
  cardHeight: number,
): InspectorEdge {
  const bottomZoneTop = paneRect.bottom - cardHeight - CARD_PLACEMENT_SAFETY_PX;
  const overlapsBottomZone = targetRect.bottom > bottomZoneTop && targetRect.top < paneRect.bottom;
  return overlapsBottomZone ? "top" : "bottom";
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

  const osInput = document.createElement("input");
  osInput.type = "color";
  osInput.className = "theme-inspector-os-input";
  osInput.hidden = true;
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

  function openOsPicker(): void {
    const key = activeKey();
    if (!key) return;
    osPickerKey = key;
    osInput.value = toDisplayHex(currentBaselineHex(key));
    osInput.click();
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

  /** Command/CQS: void. Sets which sticky edge (top/bottom) the card docks
   *  to. Called ONLY from setTarget (see module doc comment, invariant B) —
   *  reflectValues() must never call this. */
  function placeInspector(edge: InspectorEdge): void {
    el.classList.toggle("edge-top", edge === "top");
    el.classList.toggle("edge-bottom", edge === "bottom");
  }

  /** "이 타깃이 걸쳐 있는 진짜 범위" (순수 쿼리) — 대부분의 타깃은 엘리먼트
   *  1개뿐이라 그 rect 그대로지만, `fg`처럼 문단 전체에 흩어진 런 여러 개가
   *  같은 `data-target`을 공유하는 그룹 타깃은 클릭된 그 런 하나의 rect만
   *  보고 배치를 정하면 **다른 런들은 여전히 카드 밑에 파묻힐 수 있다**
   *  (2026-08 폴리시 리뷰 2차 지적 — h1/muted 같은 단일-엘리먼트 타깃 2건만
   *  실측했었고, fg는 확인이 안 돼 있었다). 같은 `data-target`을 가진 모든
   *  엘리먼트의 bounding union을 구해 그 전체 범위로 겹침을 판정한다 —
   *  단일 엘리먼트 타깃은 union이 곧 그 엘리먼트 자신의 rect이므로 동작이
   *  전혀 안 바뀐다. Pure query. */
  function unionRectForTarget(id: string, fallback: HTMLElement): { top: number; bottom: number } {
    const els = Array.from(document.querySelectorAll<HTMLElement>(`[data-target="${id}"]`));
    if (els.length === 0) return fallback.getBoundingClientRect();
    let top = Infinity;
    let bottom = -Infinity;
    for (const e of els) {
      const r = e.getBoundingClientRect();
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
    }
    return { top, bottom };
  }

  /** "선택된 요소(그룹 전체)를 피해 앉을 자리" — targetEl을 스크롤로 노출시킨
   *  뒤(카드 존을 피하도록 CSS scroll-margin이 이미 걸려 있다) `unionRectForTarget`
   *  으로 구한 그룹 전체 범위를 카드 존과 대조해 edge를 정한다. **정련된
   *  불변식 A**(2026-08 폴리시 리뷰 2차, `_workspace/01_ui2_design.md` 결정 7
   *  갱신): "클릭된 그 엘리먼트는 항상 카드 밖에 있어야 한다"는 여전히
   *  엄격하게 보장되지만(스크롤+scroll-margin), fg처럼 그룹이 팬 높이를 넘게
   *  퍼져 있으면 **그룹 전체의 완전한 비-오버랩은 구조적으로 보장하지
   *  않는다** — union 기준 판정은 "가능한 한 그룹과 안 겹치는 쪽"을 고르는
   *  최선의 노력이지, 모든 런이 항상 다 보인다는 약속이 아니다. `targetEl`이
   *  없으면(방어적 기본값) "bottom". jsdom에서는 rect가 전부 0이라 항상
   *  "bottom"으로 안정적으로 떨어진다 — 실제 배치 검증은 실브라우저에서
   *  한다. */
  function computeEdge(targetEl: HTMLElement | null): InspectorEdge {
    if (!targetEl || !target) return "bottom";
    const pane = el.closest<HTMLElement>(".settings-pane") ?? document.documentElement;
    const groupRect = unionRectForTarget(target.id, targetEl);
    return pickInspectorEdge(groupRect, pane.getBoundingClientRect(), el.offsetHeight);
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
    // Round 2 decision 7: scroll the SELECTED ELEMENT into view (not the
    // inspector) — CSS scroll-margin on `.theme-target`/`.theme-frame`
    // reserves the card's zone so the target doesn't land underneath it.
    // Instant (not smooth) so the very next rect measurement below reflects
    // the FINAL scrolled position, not a mid-animation one.
    targetEl?.scrollIntoView?.({ behavior: "auto", block: "nearest" });
    placeInspector(computeEdge(targetEl ?? null));
  }

  render();
  // The SOLE reaction to every color write (this inspector's own writes AND
  // any external one — JSON apply, preset switch): reflect values in place.
  // Never render() or placeInspector() here — a write never changes which
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
