// The registry layer over the defineSetting SSOT primitive. registerSetting is
// the single declaration site the panel iterates: it stores like defineSetting
// AND (iff the def carries `ui`) records {setting, ui} in an insertion-ordered
// module registry so groups() can render the panel without anyone hand-listing
// settings. Adding a panel preference is one registerSetting(...) call; the
// panel changes nothing.
import { defineSetting, type SettingDef, type Setting, type SettingUi } from "./store";

/** One rendered row: the live setting + its DOM-free presentation metadata. */
export interface RegistryEntry<T = unknown> {
  setting: Setting<T>;
  ui: SettingUi<T>;
}

/** One sidebar category: a name + the rows registered under it, in order. */
export interface Group {
  name: string;
  entries: RegistryEntry[];
}

// Insertion-ordered list of every ui-bearing setting. Module-level singleton so
// app.ts declarations populate it at import time and the panel reads it back.
const entries: RegistryEntry[] = [];

/** Declare a setting (storage via defineSetting) and, iff it carries `ui`,
 *  register it for the panel. Returns the Setting so callers bind/set as usual.
 *  Storage semantics are exactly defineSetting's — registry only adds the row. */
export function registerSetting<T>(def: SettingDef<T>): Setting<T> {
  const setting = defineSetting(def);
  if (def.ui) entries.push({ setting, ui: def.ui } as RegistryEntry);
  return setting;
}

/** The panel's view of the registry: settings grouped by `ui.group`, with both
 *  groups and entries in registration (insertion) order. Pure query — builds a
 *  fresh array each call, never mutates the registry. */
export function groups(): Group[] {
  const out: Group[] = [];
  const byName = new Map<string, Group>();
  for (const entry of entries) {
    const name = entry.ui.group;
    let group = byName.get(name);
    if (!group) {
      group = { name, entries: [] };
      byName.set(name, group);
      out.push(group); // first sighting fixes the group's position
    }
    group.entries.push(entry);
  }
  return out;
}
