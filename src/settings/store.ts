// A persisted, observable single value. The SSOT primitive: declare a
// preference once with { key, default }, then let any number of sinks subscribe.
// Dependency-free (plain closure + Set of listeners) to honor the fast-load
// constraint — no reactive framework.

export interface SettingDef<T> {
  /** localStorage key the value persists under. */
  key: string;
  /** Value used when nothing valid is stored. */
  default: T;
  /** Validate a raw stored string into a value; return null to use the default. */
  parse?: (raw: string | null) => T | null;
  /** Serialize a value for storage (default: String(v)). */
  serialize?: (v: T) => string;
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
