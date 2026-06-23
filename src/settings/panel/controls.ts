// The RENDER dispatch table: one renderer per control kind, keyed by `kind` so
// the panel never branches on an inline if/switch. Each renderer (a) builds the
// input reflecting setting.get(), (b) wires input → setting.set, and (c)
// setting.subscribe(reflect) so an external change updates the control live
// (the bind round-trip). Returns a labeled row element ready to append.
import type { Setting, Control } from "../store";
import type { Theme } from "../theme-schema";
import { parseTheme, serializeTheme } from "../theme-schema";

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
function renderJson(setting: Setting<Theme>): HTMLElement {
  const { row: r, cell } = row("");
  r.classList.add("settings-row-json");
  r.classList.add("theme-editor");

  // 1. Swatch Grid Container
  const grid = document.createElement("div");
  grid.className = "theme-swatch-grid";

  const colorLabels: Record<keyof Theme["colors"], string> = {
    bg: "배경색",
    fg: "글자색",
    surface: "카드 영역",
    border: "테두리색",
    accent: "강조색",
    link: "링크색",
    muted: "보조 글자",
    highlightBg: "형광펜 배경",
  };

  const colorInputs: Record<string, HTMLInputElement> = {};
  const swatchColors: Record<string, HTMLElement> = {};

  const keys = Object.keys(colorLabels) as Array<keyof Theme["colors"]>;

  keys.forEach((key) => {
    const card = document.createElement("div");
    card.className = "theme-swatch-card";

    const wrapper = document.createElement("div");
    wrapper.className = "theme-swatch-wrapper";

    const swatch = document.createElement("div");
    swatch.className = "theme-swatch-color";

    const input = document.createElement("input");
    input.type = "color";
    input.className = "theme-swatch-input";
    input.title = colorLabels[key];

    input.addEventListener("input", () => {
      const activeTheme = setting.get();
      const updatedTheme: Theme = {
        ...activeTheme,
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
    label.textContent = colorLabels[key];

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

  // 3. Reflect changes and subscribe
  const reflect = (t: Theme) => {
    keys.forEach((key) => {
      const colorVal = t.colors[key];
      colorInputs[key].value = toHex(colorVal);
      swatchColors[key].style.backgroundColor = colorVal;
    });

    ta.value = serializeTheme(t);
    error.textContent = "";
  };

  reflect(setting.get());
  setting.subscribe(reflect);

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
