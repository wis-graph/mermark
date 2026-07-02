// The RENDER dispatch table: one renderer per control kind, keyed by `kind` so
// the panel never branches on an inline if/switch. Each renderer (a) builds the
// input reflecting setting.get(), (b) wires input → setting.set, and (c)
// setting.subscribe(reflect) so an external change updates the control live
// (the bind round-trip). Returns a labeled row element ready to append.
import type { Setting, Control } from "../store";
import type { Theme } from "../theme-schema";
import { parseTheme, serializeTheme } from "../theme-schema";
import { SHORTCUT_ACTIONS } from "../../shortcuts/actions";
import { effectiveBinding, findConflict, suppressDispatcher } from "../../shortcuts/registry";
import { eventToChord, displayChord } from "../../shortcuts/keys";

// Subscription cleanup: a control that calls setting.subscribe must hand back its
// unsubscribe fns so the modal can tear them down on category swap / close,
// otherwise stale reflect closures pile up on dead DOM (a memory leak + writes to
// detached nodes). We stash the fns on the element via a WeakMap (no `any` cast,
// no DOM-expando typing) keyed by the returned row element. The modal calls
// runTeardown(el) before discarding a pane's children.
const teardowns = new WeakMap<HTMLElement, Array<() => void>>();

/** Record a control element's unsubscribe fns so the modal can clean them up
 *  later. Named so the leak rule isn't an inline expando assignment. */
export function attachTeardown(el: HTMLElement, unsubs: Array<() => void>): void {
  teardowns.set(el, unsubs);
}

/** Run and clear a control element's unsubscribe fns. Idempotent: after running
 *  once the entry is dropped, so a second call (close after swap) is a no-op.
 *  Command/CQS: void. */
export function runTeardown(el: HTMLElement): void {
  const unsubs = teardowns.get(el);
  if (!unsubs) return;
  teardowns.delete(el);
  for (const u of unsubs) u();
}

/** Build the labeled row shell every control shares (label cell + control cell).
 *  The control cell is returned for the renderer to fill. */
function row(label: string): { row: HTMLElement; cell: HTMLElement } {
  const r = document.createElement("div");
  r.className = "settings-row";
  const l = document.createElement("label");
  l.className = "settings-row-label";
  l.textContent = label;
  const cell = document.createElement("div");
  cell.className = "settings-row-control";
  r.append(l, cell);
  return { row: r, cell };
}

function renderSegmented<T>(setting: Setting<T>, control: Extract<Control<T>, { kind: "segmented" }>): HTMLElement {
  const { row: r, cell } = row("");
  const group = document.createElement("div");
  group.className = "settings-segmented";
  cell.appendChild(group);
  const buttons = control.options.map((opt) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "settings-seg-btn";
    b.textContent = opt.label;
    b.addEventListener("click", () => setting.set(opt.value));
    group.appendChild(b);
    return { b, value: opt.value };
  });
  const reflect = (v: T) => {
    for (const { b, value } of buttons) b.setAttribute("aria-pressed", String(Object.is(value, v)));
  };
  reflect(setting.get());
  setting.subscribe(reflect);
  return r;
}

function renderSelect<T>(setting: Setting<T>, control: Extract<Control<T>, { kind: "select" }>): HTMLElement {
  const { row: r, cell } = row("");
  const select = document.createElement("select");
  select.className = "settings-select";
  // The option's DOM value IS the setting value (round-1 selects are string-valued:
  // font stacks, heading ratios), so select.value round-trips the SSOT value 1:1.
  for (const opt of control.options) {
    const o = document.createElement("option");
    o.value = String(opt.value);
    o.textContent = opt.label;
    select.appendChild(o);
  }
  select.addEventListener("change", () => {
    const opt = control.options.find((o) => String(o.value) === select.value);
    if (opt) setting.set(opt.value);
  });
  const reflect = (v: T) => (select.value = String(v));
  reflect(setting.get());
  setting.subscribe(reflect);
  cell.appendChild(select);
  return r;
}

function renderSlider<T>(setting: Setting<T>, control: Extract<Control<T>, { kind: "slider" }>): HTMLElement {
  const { row: r, cell } = row("");
  const range = document.createElement("input");
  range.type = "range";
  range.className = "settings-slider";
  range.min = String(control.min);
  range.max = String(control.max);
  range.step = String(control.step);
  const out = document.createElement("span");
  out.className = "settings-slider-value";
  const show = (n: number) => (out.textContent = `${n}${control.unit ?? ""}`);
  range.addEventListener("input", () => {
    const n = Number(range.value);
    setting.set(n as unknown as T);
    show(n);
  });
  const reflect = (v: T) => {
    range.value = String(v);
    show(Number(v));
  };
  reflect(setting.get());
  setting.subscribe(reflect);
  cell.append(range, out);
  return r;
}

/** A free-text input (the web-font family name). Stores the raw typed string —
 *  validation/sanitization is NOT this renderer's job; it lives downstream in
 *  googleFontHref (the single URL builder) so the textbox round-trips exactly
 *  what the user typed. (a) value = setting.get(), (b) input → setting.set(raw),
 *  (c) subscribe(reflect) for external changes. `help`, if given, renders a
 *  muted hint node below the input. */
function renderText(setting: Setting<string>, control: Extract<Control<string>, { kind: "text" }>): HTMLElement {
  const { row: r, cell } = row("");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "settings-text";
  if (control.placeholder) input.placeholder = control.placeholder;
  input.addEventListener("input", () => setting.set(input.value)); // raw; sanitized downstream
  const reflect = (v: string) => (input.value = v);
  reflect(setting.get());
  setting.subscribe(reflect);
  cell.appendChild(input);
  if (control.help) {
    const hint = document.createElement("div");
    hint.className = "settings-text-help";
    hint.textContent = control.help;
    cell.appendChild(hint);
  }
  return r;
}

/** The JSON control owns import (parse-on-적용) and export (copy/download). It is
 *  the only renderer with extra responsibility, all of it routed through the
 *  named theme rules (parseTheme/serializeTheme) — never an inline JSON.parse. A
 *  malformed paste shows an inline error and does NOT call set, so a corrupt
 *  import can't poison the SSOT. */
// The 18 swatch cards, in render order: the 9 CORE colors first (column 1), then
// the 9 MARKDOWN element colors (column 2). `key` is a Theme["colors"] field;
// `label` is the spec's exact Korean text / markdown syntax shown on the card;
// `previewVar` (markdown cards only) is the CSS var the inline preview's color is
// bound to, so picking a color live-updates both the panel preview and the editor.
type SwatchCard = { key: keyof Theme["colors"]; label: string; previewVar?: string };

const CORE_CARDS: SwatchCard[] = [
  { key: "bg", label: "에디터 배경색" },
  { key: "fg", label: "기본 본문 글자색" },
  { key: "surface", label: "카드 영역 배경색" },
  { key: "border", label: "테두리선 색상" },
  { key: "accent", label: "강조 요소 색상" },
  { key: "link", label: "[[위키링크 (Link)]]" },
  { key: "muted", label: "보조 텍스트 (Muted)" },
  { key: "highlightBg", label: "==형광펜 배경색 (Highlight Bg)==" },
  { key: "highlight", label: "==형광펜 글자색 (Highlight Text)==" },
];

const MARKDOWN_CARDS: SwatchCard[] = [
  { key: "h1", label: "# 제목 1 (H1)", previewVar: "--h1-color" },
  { key: "h2", label: "## 제목 2 (H2)", previewVar: "--h2-color" },
  { key: "h3", label: "### 제목 3 (H3)", previewVar: "--h3-color" },
  { key: "h4", label: "#### 제목 4 (H4)", previewVar: "--h4-color" },
  { key: "h5", label: "##### 제목 5 (H5)", previewVar: "--h5-color" },
  { key: "h6", label: "###### 제목 6 (H6)", previewVar: "--h6-color" },
  { key: "bold", label: "**굵은 글자 (Bold)**", previewVar: "--bold-color" },
  { key: "italic", label: "*기울임꼴 (Italic)*", previewVar: "--italic-color" },
  { key: "code", label: "`인라인 코드 (Code)`", previewVar: "--code-color" },
];

const ALL_CARDS: SwatchCard[] = [...CORE_CARDS, ...MARKDOWN_CARDS];

function renderJson(setting: Setting<Theme>): HTMLElement {
  const { row: r, cell } = row("");
  r.classList.add("settings-row-json");
  r.classList.add("theme-editor");

  // 1. Swatch Grid Container (2-column: core column then markdown column)
  const grid = document.createElement("div");
  grid.className = "theme-swatch-grid";

  const colorInputs: Partial<Record<keyof Theme["colors"], HTMLInputElement>> = {};
  const swatchColors: Partial<Record<keyof Theme["colors"], HTMLElement>> = {};

  ALL_CARDS.forEach(({ key, label: cardLabel, previewVar }) => {
    const card = document.createElement("div");
    card.className = "theme-swatch-card";

    const wrapper = document.createElement("div");
    wrapper.className = "theme-swatch-wrapper";

    const swatch = document.createElement("div");
    swatch.className = "theme-swatch-color";

    const input = document.createElement("input");
    input.type = "color";
    input.className = "theme-swatch-input";
    input.title = cardLabel;

    input.addEventListener("input", () => {
      const activeTheme = setting.get();
      const updatedTheme: Theme = {
        ...activeTheme, // preserves `name` so editing never renames the preset
        colors: {
          ...activeTheme.colors,
          [key]: input.value,
        },
      };
      setting.set(updatedTheme);
    });

    wrapper.append(swatch, input);
    colorInputs[key] = input;
    swatchColors[key] = swatch;

    const label = document.createElement("span");
    label.className = "theme-swatch-label";
    // Markdown cards show a LIVE preview element whose color inherits the CSS var
    // (the single color source), so picking updates panel + editor together. Core
    // cards have no inline preview — the swatch circle IS the preview.
    if (previewVar) {
      label.classList.add(`theme-preview-${String(key)}`);
      label.style.color = `var(${previewVar})`;
    }
    label.textContent = cardLabel;

    card.append(wrapper, label);
    grid.appendChild(card);
  });

  // 2. Collapsible Advanced JSON Editor Accordion
  const details = document.createElement("details");
  details.className = "theme-advanced";
  const summary = document.createElement("summary");
  summary.className = "theme-advanced-summary";
  summary.textContent = "JSON 직접 편집";
  details.appendChild(summary);

  const ta = document.createElement("textarea");
  ta.className = "settings-json";
  ta.spellcheck = false;
  ta.rows = 8;
  const error = document.createElement("div");
  error.className = "settings-json-error";

  const actions = document.createElement("div");
  actions.className = "settings-json-actions";
  const apply = button("적용", "apply");
  const copy = button("복사", "copy");
  const download = button("내려받기", "download");
  actions.append(apply, copy, download);

  apply.addEventListener("click", () => {
    const parsed = parseTheme(ta.value);
    if (parsed === null) {
      error.textContent = "유효하지 않은 테마 JSON입니다.";
      return;
    }
    error.textContent = "";
    setting.set(parsed);
  });

  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(serializeTheme(setting.get()));
  });

  download.addEventListener("click", () => downloadTheme(setting.get()));

  details.append(ta, error, actions);

  // 3. Reflect changes and subscribe. The picker value + swatch fill come from the
  // resolved 18-key theme (parseTheme/builtInTheme always fill extended keys; the
  // `?? ""` guards a hand-built 8-key object so an unfilled key just renders blank
  // rather than throwing). The markdown preview colors are NOT recomputed here —
  // they inherit their CSS var, whose single writer is themeVarsSink.
  const reflect = (t: Theme) => {
    ALL_CARDS.forEach(({ key }) => {
      const colorVal = t.colors[key] ?? "";
      const input = colorInputs[key];
      const swatch = swatchColors[key];
      if (input) input.value = toHex(colorVal);
      if (swatch) swatch.style.backgroundColor = colorVal;
    });

    ta.value = serializeTheme(t);
    error.textContent = "";
  };

  reflect(setting.get());
  // Collect the unsubscribe so the modal can tear this control down on swap/close
  // (avoids stale reflect closures writing into detached DOM).
  attachTeardown(r, [setting.subscribe(reflect)]);

  cell.append(grid, details);
  return r;
}

function button(label: string, act: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "settings-json-btn";
  b.dataset.act = act;
  b.textContent = label;
  return b;
}

/** Export a theme as a downloadable theme.json (pure frontend: Blob + a
 *  programmatic <a download>, no IPC). */
function downloadTheme(t: Theme): void {
  const blob = new Blob([serializeTheme(t)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "theme.json";
  a.click();
  URL.revokeObjectURL(url);
}

/** The keybind control: ONE setting (keybindingsSetting, a { id: chord }
 *  override map) rendered as MANY rows — one per SHORTCUT_ACTION — like the json
 *  control's 1→18 fan-out. Each row shows the action label, its effective chord
 *  (override ?? default via effectiveBinding), a capture ("재정의") button, and an
 *  individual reset; a 전체 리셋 button sits on top.
 *
 *  Round-trip contract (SETTINGS_COMPONENT_SPEC): (a) mount reflects
 *  setting.get() through effectiveBinding, (b) a captured chord writes
 *  setting.set({ ...cur, [id]: chord }), (c) setting.subscribe(reflect) tracks
 *  external changes. Capture arms a one-shot global keydown that reads the chord
 *  (eventToChord), rejects a conflict (findConflict) with an inline warning, and
 *  suppresses the global dispatcher while armed (so the chord being assigned
 *  doesn't fire its current action). Esc cancels. attachTeardown releases the
 *  subscription AND any still-armed capture on modal swap/close. */
function renderKeybind(setting: Setting<Record<string, string>>): HTMLElement {
  const { row: r, cell } = row("");
  r.classList.add("settings-row-keybind");

  const wrap = document.createElement("div");
  wrap.className = "keybind-editor";

  const toolbar = document.createElement("div");
  toolbar.className = "keybind-toolbar";
  const resetAll = document.createElement("button");
  resetAll.type = "button";
  resetAll.className = "keybind-reset-all";
  resetAll.textContent = "전체 리셋";
  resetAll.addEventListener("click", () => setting.set({}));
  toolbar.appendChild(resetAll);
  wrap.appendChild(toolbar);

  const list = document.createElement("div");
  list.className = "keybind-list";
  wrap.appendChild(list);

  // The currently armed capture's cleanup (remove its keydown listener + release
  // dispatcher suppression), or null when idle. Stored so teardown can disarm a
  // capture left open when the modal closes mid-assignment.
  let disarm: (() => void) | null = null;

  // Per-action reflectors, run on mount and on every external setting change.
  const reflectors: Array<() => void> = [];

  for (const action of SHORTCUT_ACTIONS) {
    const item = document.createElement("div");
    item.className = "keybind-item";
    item.dataset.id = action.id;

    const label = document.createElement("span");
    label.className = "keybind-label";
    label.textContent = action.label;

    const chord = document.createElement("span");
    chord.className = "keybind-chord";

    const warning = document.createElement("span");
    warning.className = "keybind-warning";
    warning.hidden = true;

    const capture = document.createElement("button");
    capture.type = "button";
    capture.className = "keybind-capture";
    capture.textContent = "재정의";

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "keybind-reset";
    reset.textContent = "기본값";
    reset.addEventListener("click", () => {
      const next = { ...setting.get() };
      delete next[action.id]; // remove override → fall back to the default
      setting.set(next);
    });

    /** Reflect this action's effective chord (override ?? default). Shows a
     *  muted "미지정" when the action is unbound. */
    const reflect = (): void => {
      const eff = effectiveBinding(action.id);
      chord.textContent = eff ? displayChord(eff) : "미지정";
      chord.classList.toggle("is-unbound", !eff);
    };
    reflectors.push(reflect);

    /** End the armed capture: drop the listener, un-suppress the dispatcher, and
     *  restore the button. Idempotent. */
    const endCapture = (): void => {
      disarm?.();
      disarm = null;
      capture.textContent = "재정의";
      capture.classList.remove("is-capturing");
    };

    capture.addEventListener("click", () => {
      if (disarm) {
        endCapture(); // clicking an armed capture cancels it
        return;
      }
      warning.hidden = true;
      capture.textContent = "키를 누르세요…";
      capture.classList.add("is-capturing");
      suppressDispatcher(true);
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.code === "Escape" || e.key === "Escape") {
          endCapture();
          return;
        }
        const c = eventToChord(e);
        if (!c) return; // lone modifier / unbindable — keep waiting
        const conflict = findConflict(c, action.id);
        if (conflict) {
          const other = SHORTCUT_ACTIONS.find((a) => a.id === conflict);
          warning.textContent = `이미 '${other?.label ?? conflict}'에 할당됨`;
          warning.hidden = false;
          endCapture();
          return;
        }
        setting.set({ ...setting.get(), [action.id]: c });
        endCapture();
      };
      window.addEventListener("keydown", onKey, true);
      disarm = () => {
        window.removeEventListener("keydown", onKey, true);
        suppressDispatcher(false);
      };
    });

    item.append(label, chord, capture, reset, warning);
    list.appendChild(item);
  }

  const reflectAll = () => {
    for (const reflect of reflectors) reflect();
  };
  reflectAll();
  // Teardown: release the subscription AND disarm any capture left open when the
  // modal closes mid-assignment (else its window listener + dispatcher
  // suppression would leak).
  attachTeardown(r, [setting.subscribe(reflectAll), () => disarm?.()]);

  cell.appendChild(wrap);
  return r;
}

/** A read-only placeholder row (the empty Plugins category in round 1). Any
 *  future feature that calls registerSetting with its own ui.group renders
 *  through the real controls; this is the "nothing here yet" filler. */
function renderInfo(): HTMLElement {
  const { row: r, cell } = row("");
  r.classList.add("settings-row-info");
  cell.textContent = "등록된 플러그인 설정이 없습니다.";
  return r;
}

/** The dispatch table. The panel calls RENDER[entry.ui.control.kind](setting,
 *  control). Typed loosely at the table boundary because each renderer narrows
 *  its own control kind; callers pass the matching pair. */
export const RENDER: {
  [K in Control<unknown>["kind"]]: (
    setting: Setting<never>,
    control: Extract<Control<unknown>, { kind: K }>,
  ) => HTMLElement;
} = {
  segmented: (s, c) => renderSegmented(s as Setting<unknown>, c),
  select: (s, c) => renderSelect(s as Setting<unknown>, c),
  slider: (s, c) => renderSlider(s as Setting<unknown>, c),
  text: (s, c) => renderText(s as unknown as Setting<string>, c),
  json: (s) => renderJson(s as unknown as Setting<Theme>),
  keybind: (s) => renderKeybind(s as unknown as Setting<Record<string, string>>),
  info: () => renderInfo(),
};

/** Convert a CSS color string (hex, rgb, rgba) to '#rrggbb' hex format required by <input type="color">. */
function toHex(color: string): string {
  const trimmed = color.trim().toLowerCase();
  if (trimmed.startsWith("#")) {
    if (trimmed.length === 4) {
      return "#" + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
    }
    if (trimmed.length >= 7) {
      return trimmed.slice(0, 7);
    }
    return trimmed;
  }
  const match = trimmed.match(/\d+/g);
  if (match && match.length >= 3) {
    const r = Math.min(255, Math.max(0, parseInt(match[0], 10))).toString(16).padStart(2, "0");
    const g = Math.min(255, Math.max(0, parseInt(match[1], 10))).toString(16).padStart(2, "0");
    const b = Math.min(255, Math.max(0, parseInt(match[2], 10))).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  }
  // Default fallback if color is transparent or named
  if (trimmed === "transparent") return "#000000";
  return "#000000";
}
