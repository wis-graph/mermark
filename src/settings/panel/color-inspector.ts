// The docked color inspector (design decision 1: "도킹 인스펙터", NOT a
// floating popover — it lives directly under the mini app frame so the
// document stays visible while a slider is dragged). Exactly one inspector
// instance backs the whole panel; theme-preview.ts calls setTarget() on
// every selection change and this module owns everything downstream of that:
// tabs (글자색/배경색), the 8-chip palette, 3 HSL sliders, "프리셋
// 기본값으로", and the OS-picker escape hatch. NO HEX INPUT FIELD anywhere —
// design decision 6 rejects it outright ("누가 그걸 외워서 입력하냐"); hex is
// DISPLAYED (read-only text), never typed.
//
// STRUCTURE vs VALUE (2026-08 audit fix — blocker #1): `render()` REBUILDS
// the DOM and must only run when the STRUCTURE changes (which target/tab is
// active — different targets show different controls: tabs present/absent,
// "없음" chip present/absent). `reflectValues()` never rebuilds anything; it
// only writes into DOM refs render() already created (dot background, hex
// text, chip aria-pressed, slider .value). Every color write goes through
// `reflectValues()`, never `render()` — writing a color does NOT change
// which controls exist, only what they currently show. This split matches
// controls.ts's build-once-then-reflect idiom used by every other renderer
// in this panel; this file was the one holdout that rebuilt on every write,
// and that rebuild is exactly what broke HSL slider dragging: destroying and
// recreating an `<input type=range>` mid-drag drops the browser's implicit
// pointer capture (the spec clears capture when the captured element leaves
// the document), so the drag died after its first `input` event. Confirmed
// live via a real mouse drag (mousedown + 8 mousemove + mouseup) over CDP —
// before this fix, the slider element's identity changed after step 1 and
// the value froze; after, the same element persists for the whole gesture
// and the value tracks the pointer through all 8 steps (see
// tests/color-inspector.test.ts's "survives a multi-step drag" test, which
// locks this by asserting element identity + cumulative value across a
// simulated multi-input sequence).
import type { Setting } from "../store";
import { builtInTheme, type PresetName, type Theme } from "../theme-schema";
import { hexToHsl, hslToHex } from "./color-math";
import { hasBackgroundTab, type ThemeTarget } from "./theme-preview";

type Tab = "color" | "bg";

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
 *  the "프리셋 기본값으로" button's target value and the fallback slider
 *  baseline while a background key reads as 없음. A custom (non-builtin)
 *  theme name falls back to the light preset's value — a neutral default
 *  rather than throwing, since a customized theme has no "its own" preset to
 *  read back. Pure query. */
export function presetDefaultFor(theme: Theme, key: keyof Theme["colors"]): string | undefined {
  const presetName: PresetName = theme.name === "dark" || theme.name === "light" || theme.name === "claude" ? theme.name : "light";
  return builtInTheme(presetName).colors[key];
}

/** Read `key`'s stored value off `theme`, or undefined if unset/blank — the
 *  "없음" state for a background key. Pure query. */
function storedValue(theme: Theme, key: keyof Theme["colors"]): string | undefined {
  const v = theme.colors[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface ColorInspector {
  el: HTMLElement;
  /** Command/CQS: void. Called by theme-preview's onSelect. */
  setTarget(t: ThemeTarget | null): void;
  teardown(): void;
}

/** Build the docked inspector. `setting` is the SAME themeJsonSetting the
 *  frame's CSS vars are sourced from — every write here goes through
 *  setting.set, never a direct CSS var write, so the frame (which paints via
 *  var(--x)) picks up the change through the existing themeVarsSink path,
 *  not a second one. */
export function buildColorInspector(setting: Setting<Theme>): ColorInspector {
  const el = document.createElement("div");
  el.className = "theme-inspector";

  let target: ThemeTarget | null = null;
  let tab: Tab = "color";
  // A one-shot bridge to the hidden native color input: openOsPicker arms it
  // for the CURRENTLY active key, so its own `input` handler (registered
  // once, outside render()) always writes to whichever key was active when
  // the OS dialog was opened, even though render() rebuilds the DOM around it.
  let osPickerKey: keyof Theme["colors"] | null = null;

  // Live DOM refs the STRUCTURAL render() assigns and reflectValues() reads.
  // null whenever nothing is selected (the hint-only state has none of these).
  let dotEl: HTMLElement | null = null;
  let hexEl: HTMLElement | null = null;
  let noneChip: HTMLButtonElement | null = null;
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
    return toDisplayHex(presetDefaultFor(theme, key) ?? "#808080");
  }

  // Command/CQS: void. Writes never call render() — only reflectValues(),
  // via the setting.subscribe below. Writing a color changes what the
  // controls SHOW, never which controls EXIST, so no rebuild is warranted
  // (see the module doc comment's structure/value split).
  function writeColor(key: keyof Theme["colors"], value: string): void {
    const cur = setting.get();
    setting.set({ ...cur, colors: { ...cur.colors, [key]: value } });
  }

  function writeNone(key: keyof Theme["colors"]): void {
    const cur = setting.get();
    const nextColors = { ...cur.colors } as Record<string, unknown>;
    delete nextColors[key]; // absent key = 없음 (design decision 3's storage rule)
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
   *  creating/removing a single DOM node. Safe to call from the middle of an
   *  active slider drag (see module doc comment) — and safe to call when no
   *  structural body exists yet (all refs null → every branch below is a
   *  no-op, so callers never need to check `target` first). Command/CQS:
   *  void. */
  function reflectValues(): void {
    if (!target) return;
    const key = activeKey();
    if (!key) return;
    const theme = setting.get();
    const value = storedValue(theme, key);
    const isNone = tab === "bg" && value === undefined;
    const displayHex = value !== undefined ? toDisplayHex(value) : undefined;
    const dflt = presetDefaultFor(theme, key);

    if (dotEl) {
      dotEl.style.background = isNone ? "transparent" : `var(${tab === "bg" ? target.bgVar : target.colorVar})`;
      dotEl.classList.toggle("is-none", isNone);
    }
    if (hexEl) hexEl.textContent = isNone ? "없음" : (displayHex ?? "");
    if (noneChip) noneChip.setAttribute("aria-pressed", String(isNone));
    if (defaultChip) defaultChip.setAttribute("aria-pressed", String(!isNone && value === dflt));
    for (const chip of curatedChips) {
      const hex = chip.dataset.hex!;
      chip.setAttribute("aria-pressed", String(!isNone && value?.toLowerCase() === hex));
    }

    const baselineHex = displayHex !== undefined ? displayHex : toDisplayHex(dflt ?? "#808080");
    const hsl = hexToHsl(baselineHex);
    if (sliderH) sliderH.value = String(Math.round(hsl.h));
    if (sliderS) sliderS.value = String(Math.round(hsl.s));
    if (sliderL) sliderL.value = String(Math.round(hsl.l));
  }

  /** STRUCTURAL rebuild: which controls exist for the current (target, tab).
   *  Called ONLY from setTarget() and a tab-switch click — never from a
   *  color write. Ends by calling reflectValues() once, so the freshly built
   *  controls start out showing the right values. */
  function render(): void {
    el.querySelectorAll(".theme-inspector-body, .theme-inspector-hint").forEach((n) => n.remove());
    dotEl = null;
    hexEl = null;
    noneChip = null;
    defaultChip = null;
    curatedChips = [];
    sliderH = null;
    sliderS = null;
    sliderL = null;

    if (!target) {
      const hint = document.createElement("p");
      hint.className = "theme-inspector-hint";
      hint.textContent = "문서에서 요소를 선택하면 여기서 색을 바꿉니다.";
      el.appendChild(hint);
      return;
    }

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
    head.append(dotEl, labelEl, hexEl);
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
          tab = id; // structural: the control SET differs between tabs (없음 chip, key)
          render();
        });
        return b;
      };
      tabs.append(mkTab("color", "글자색"), mkTab("bg", "배경색"));
      body.appendChild(tabs);
    }

    const palette = document.createElement("div");
    palette.className = "theme-inspector-palette";

    // "없음" chip: only on the background tab, and only when this target's
    // background is droppable (highlightBg — the sole bgOptional:false key
    // — never shows one, since it's a required core color). Existence
    // depends only on (tab, target.bgOptional) — both structural — so it's
    // built here once, never toggled by reflectValues().
    if (tab === "bg" && target.bgOptional) {
      noneChip = document.createElement("button");
      noneChip.type = "button";
      noneChip.className = "theme-chip theme-chip-none";
      noneChip.setAttribute("aria-label", "배경 없음");
      noneChip.addEventListener("click", () => writeNone(key));
      palette.appendChild(noneChip);
    }

    // presetDefaultFor(key)'s definedness depends only on `key` (every
    // core/extended color key is always defined by every built-in preset;
    // no built-in preset currently defines any background key) — stable for
    // the lifetime of this structural render, so building it once here
    // (rather than toggling presence in reflectValues) is correct.
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

  function setTarget(t: ThemeTarget | null): void {
    target = t;
    tab = "color"; // structural: switching targets always lands on the color tab
    render();
    // 2026-08 polish pass (point 5): the modal's own pane scrolls, and the
    // frame can be tall enough that a fresh selection's controls land below
    // the fold — the user sees nothing happen. Scroll the inspector into
    // view on every selection so the controls that just appeared are
    // actually visible, not just "selected". `?.` guards jsdom, which may
    // not implement scrollIntoView.
    if (t) el.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }

  render();
  // The SOLE reaction to every color write (this inspector's own writes AND
  // any external one — JSON apply, preset switch): reflect values in place.
  // Never render() here — a write never changes which controls exist.
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
