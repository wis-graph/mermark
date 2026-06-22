// A persisted, observable single value. The SSOT primitive: declare a
// preference once with { key, default }, then let any number of sinks subscribe.
// Dependency-free (plain closure + Set of listeners) to honor the fast-load
// constraint — no reactive framework.

/** DOM-free presentation metadata for a setting: which panel row to render for
 *  it. Plain data only (label/group/control descriptor) — no DOM, no behavior —
 *  so defineSetting stays pure and jsdom-testable. The panel module is the only
 *  DOM consumer; registry.ts reads this to build groups(). `T` is the setting's
 *  value type so a control's option values stay type-checked against it. */
export interface SettingUi<T> {
  /** Row label shown in the panel. */
  label: string;
  /** Sidebar category this setting belongs to (e.g. "테마", "타이포그래피"). */
  group: string;
  /** Which control renders this setting (RENDER dispatch key + its config). */
  control: Control<T>;
}

/** The control-kind descriptors the panel's RENDER dispatch table switches on.
 *  Plain data — the renderers live in panel/controls.ts. `segmented`/`select`
 *  carry typed option values; `slider` carries numeric bounds; `json`/`info`
 *  carry no config. */
export type Control<T> =
  | { kind: "segmented"; options: { value: T; label: string }[] }
  | { kind: "select"; options: { value: T; label: string }[] }
  | { kind: "slider"; min: number; max: number; step: number; unit?: string }
  | { kind: "text"; placeholder?: string; help?: string }
  | { kind: "json" }
  | { kind: "info" };

export interface SettingDef<T> {
  /** localStorage key the value persists under. */
  key: string;
  /** Value used when nothing valid is stored. */
  default: T;
  /** Validate a raw stored string into a value; return null to use the default. */
  parse?: (raw: string | null) => T | null;
  /** Serialize a value for storage (default: String(v)). */
  serialize?: (v: T) => string;
  /** Optional panel presentation. Ignored by storage; consumed only by the
   *  registry/panel. A setting with no `ui` is SSOT-only (e.g. mode, fontScale). */
  ui?: SettingUi<T>;
}

export interface Setting<T> {
  get(): T;
  set(v: T): void;
  /** Register a change-only listener. Returns an unsubscribe function. */
  subscribe(fn: (v: T) => void): () => void;
  /** Apply the current value now, then on every change. Returns unsubscribe. */
  bind(fn: (v: T) => void): () => void;
}

export function defineSetting<T>(def: SettingDef<T>): Setting<T> {
  const { key, default: dflt, parse, serialize } = def;
  const raw = localStorage.getItem(key);
  const parsed = parse ? parse(raw) : (raw as T | null);
  let value: T = parsed == null ? dflt : parsed;

  const listeners = new Set<(v: T) => void>();
  const subscribe = (fn: (v: T) => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };

  return {
    get: () => value,
    set(v: T) {
      if (Object.is(v, value)) return; // SSOT: no-op when unchanged
      value = v;
      localStorage.setItem(key, serialize ? serialize(v) : String(v));
      listeners.forEach((fn) => fn(v));
    },
    subscribe,
    bind(fn) {
      fn(value);
      return subscribe(fn);
    },
  };
}
