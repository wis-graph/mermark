// The RENDER dispatch table: one renderer per control kind, keyed by `kind` so
// the panel never branches on an inline if/switch. Each renderer (a) builds the
// input reflecting setting.get(), (b) wires input → setting.set, and (c)
// setting.subscribe(reflect) so an external change updates the control live
// (the bind round-trip). Returns a labeled row element ready to append.
import type { Setting, Control } from "../store";
import type { Theme } from "../theme-schema";
import { parseTheme, serializeTheme } from "../theme-schema";
import { allActions, effectiveBinding, findConflict, suppressDispatcher } from "../../shortcuts/registry";
import { eventToChord, displayChord } from "../../shortcuts/keys";
import { listViewers, type Viewer } from "../../chrome/viewer/registry";
import { isViewerEnabled, toggleViewerDisabled } from "../app";
import { copyTextToClipboard } from "../../clipboard";
import { buildThemePreview } from "./theme-preview";
import { buildColorInspector } from "./color-inspector";

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
  // Same optional-hint shape as renderSelect/renderText's `help`: a muted
  // line below the control, not squeezed beside it.
  if (control.help) {
    r.classList.add("settings-row-has-help");
    const hint = document.createElement("div");
    hint.className = "settings-text-help";
    hint.textContent = control.help;
    cell.appendChild(hint);
  }
  return r;
}

function renderSelect<T>(setting: Setting<T>, control: Extract<Control<T>, { kind: "select" }>): HTMLElement {
  const { row: r, cell } = row("");
  // The wrap gives the themed chevron (styles.css's .settings-select-wrap::after)
  // a positioning context — a bare <select> has none of its own for a ::after.
  const wrap = document.createElement("span");
  wrap.className = "settings-select-wrap";
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
  wrap.appendChild(select);
  cell.appendChild(wrap);
  // Same optional-hint shape as renderText's `help` (2026-07-14, headingFont):
  // a muted line below the control, not squeezed beside it.
  if (control.help) {
    r.classList.add("settings-row-has-help");
    const hint = document.createElement("div");
    hint.className = "settings-text-help";
    hint.textContent = control.help;
    cell.appendChild(hint);
  }
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
    // .settings-row-has-help (styles.css) wraps the control row so the hint
    // lands BELOW the input instead of squeezed beside it (2026-07-12
    // design-polish pass) — a general layout rule for any text control with
    // help, not a web-font-only exception.
    r.classList.add("settings-row-has-help");
    const hint = document.createElement("div");
    hint.className = "settings-text-help";
    hint.textContent = control.help;
    cell.appendChild(hint);
  }
  return r;
}

/** The JSON control owns import (parse-on-적용) and export (copy/download), plus
 *  (2026-08 redesign) the live mini-frame preview + docked color inspector that
 *  replaced the old 18-swatch grid (design: `_workspace/01_ui_design.md` 결정 1).
 *  All color edits still route through the named theme rules
 *  (parseTheme/serializeTheme for JSON, setting.set for the frame/inspector) —
 *  never an inline JSON.parse. A malformed paste shows an inline error and does
 *  NOT call set, so a corrupt import can't poison the SSOT. */
function renderJson(setting: Setting<Theme>): HTMLElement {
  const { row: r, cell } = row("");
  r.classList.add("settings-row-json");
  r.classList.add("theme-editor");

  // The frame paints every target via var(--x) (themeVarsSink is the single
  // writer of those vars), so it needs no subscription of its own — only the
  // inspector needs to know WHICH target is selected right now.
  let inspector: ReturnType<typeof buildColorInspector>;
  const preview = buildThemePreview((t) => inspector.setTarget(t));
  inspector = buildColorInspector(setting);

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
    void copyTextToClipboard(serializeTheme(setting.get()));
  });

  download.addEventListener("click", () => downloadTheme(setting.get()));

  details.append(ta, error, actions);

  // 3. Reflect the JSON textarea on every change. The frame + inspector reflect
  // themselves (the frame via CSS vars, the inspector via its own subscription
  // in color-inspector.ts) — this control only owns the textarea half.
  const reflect = (t: Theme) => {
    ta.value = serializeTheme(t);
    error.textContent = "";
  };

  reflect(setting.get());
  // Collect the unsubscribe so the modal can tear this control down on swap/close
  // (avoids stale reflect closures writing into detached DOM, and leaks in the
  // preview/inspector's own listeners).
  attachTeardown(r, [setting.subscribe(reflect), preview.teardown, inspector.teardown]);

  cell.append(preview.el, inspector.el, details);
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

  for (const action of allActions()) {
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
          const other = allActions().find((a) => a.id === conflict);
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

/** A viewer's display name for the toggle row: its `label` if set, else a
 *  derived `id (ext, ext, …)` fallback — so a viewer that forgot to set
 *  `label` still renders a row (design §3: "missing → ugly, never missing →
 *  absent"). Pure query. */
export function viewerDisplayName(v: Viewer): string {
  return v.label ?? `${v.id} (${v.extensions.join(", ")})`;
}

/** The viewer-toggles control: ONE setting (disabledViewersSetting, an array
 *  of disabled viewer ids) rendered as MANY rows — one per `listViewers()`
 *  entry — the same "1 setting → N rows" shape renderKeybind uses for
 *  SHORTCUT_ACTION (controls.ts:361-374). Enumerating the live catalog at
 *  render time is what makes "a new viewer missing from this list"
 *  structurally impossible (design §회귀 게이트) — there is no hand-maintained
 *  list to fall out of sync.
 *
 *  Round-trip contract (same as every other control here): (a) mount reflects
 *  setting.get() via isViewerEnabled, (b) a click writes
 *  setting.set(toggleViewerDisabled(cur, id)), (c) setting.subscribe(reflect)
 *  tracks external changes. attachTeardown releases the subscription on
 *  modal swap/close. */
function renderViewerToggles(setting: Setting<string[]>): HTMLElement {
  const { row: r, cell } = row("");
  r.classList.add("settings-row-viewer-toggles");

  const list = document.createElement("div");
  list.className = "settings-vtoggle-list";
  cell.appendChild(list);

  const reflectors: Array<() => void> = [];

  for (const v of listViewers()) {
    const item = document.createElement("div");
    item.className = "settings-vtoggle-item";
    item.dataset.id = v.id;

    const label = document.createElement("span");
    label.className = "settings-vtoggle-label";
    label.textContent = viewerDisplayName(v);

    const group = document.createElement("div");
    group.className = "settings-segmented settings-vtoggle-segmented";
    const onBtn = document.createElement("button");
    onBtn.type = "button";
    onBtn.className = "settings-seg-btn";
    onBtn.textContent = "켜기";
    const offBtn = document.createElement("button");
    offBtn.type = "button";
    offBtn.className = "settings-seg-btn";
    offBtn.textContent = "끄기";
    group.append(onBtn, offBtn);

    const write = (enabled: boolean) => {
      const cur = setting.get();
      const curEnabled = isViewerEnabled(cur, v.id);
      if (curEnabled === enabled) return; // SSOT no-op, mirrors defineSetting's own Object.is guard
      setting.set(toggleViewerDisabled(cur, v.id));
    };
    onBtn.addEventListener("click", () => write(true));
    offBtn.addEventListener("click", () => write(false));

    const reflect = () => {
      const enabled = isViewerEnabled(setting.get(), v.id);
      onBtn.setAttribute("aria-pressed", String(enabled));
      offBtn.setAttribute("aria-pressed", String(!enabled));
    };
    reflectors.push(reflect);
    reflect();

    item.append(label, group);
    list.appendChild(item);
  }

  const reflectAll = () => {
    for (const reflect of reflectors) reflect();
  };
  attachTeardown(r, [setting.subscribe(reflectAll)]);

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
  "viewer-toggles": (s) => renderViewerToggles(s as unknown as Setting<string[]>),
  info: () => renderInfo(),
};
