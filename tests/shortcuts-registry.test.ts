import { describe, it, expect, beforeEach, vi } from "vitest";
import { defineSetting } from "../src/settings/store";
import {
  registerHandler,
  bindKeybindings,
  effectiveBinding,
  findConflict,
  dispatchChord,
} from "../src/shortcuts/registry";

// The dispatcher: effective bindings = overrides (a setting) layered over the
// actions.ts defaults; chords resolve to injected handlers. dispatchChord is the
// pure resolve+run so tests don't depend on a real window listener.

function keybindSetting(key: string) {
  return defineSetting<Record<string, string>>({
    key,
    default: {},
    parse: (raw) => {
      if (raw == null) return null;
      try {
        const o = JSON.parse(raw);
        return o && typeof o === "object" && !Array.isArray(o) ? o : null;
      } catch {
        return null;
      }
    },
    serialize: (v) => JSON.stringify(v),
  });
}

describe("shortcut registry", () => {
  beforeEach(() => localStorage.clear());

  it("effectiveBinding returns the shipped default when unset", () => {
    bindKeybindings(keybindSetting("kb.a"));
    expect(effectiveBinding("explorer.toggle")).toBe("Mod+B");
    expect(effectiveBinding("mode.toggle")).toBe("Mod+E");
  });

  it("effectiveBinding returns the override when present", () => {
    const s = keybindSetting("kb.b");
    bindKeybindings(s);
    s.set({ "explorer.toggle": "Mod+L" });
    expect(effectiveBinding("explorer.toggle")).toBe("Mod+L");
  });

  it("dispatchChord runs the handler bound to a default chord", () => {
    bindKeybindings(keybindSetting("kb.c"));
    const fn = vi.fn();
    registerHandler("mode.toggle", fn);
    expect(dispatchChord("Mod+E")).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("an override reroutes the chord (old chord no longer fires the action)", () => {
    const s = keybindSetting("kb.d");
    bindKeybindings(s);
    const explorer = vi.fn();
    registerHandler("explorer.toggle", explorer);
    s.set({ "explorer.toggle": "Mod+L" });
    expect(dispatchChord("Mod+B")).toBe(false); // old default no longer mapped
    expect(explorer).not.toHaveBeenCalled();
    expect(dispatchChord("Mod+L")).toBe(true); // new binding
    expect(explorer).toHaveBeenCalledOnce();
  });

  it("findConflict reports the action already holding a chord, null when free", () => {
    bindKeybindings(keybindSetting("kb.e"));
    expect(findConflict("Mod+E")).toBe("mode.toggle");
    expect(findConflict("Mod+E", "mode.toggle")).toBeNull(); // excluded self
    expect(findConflict("Mod+J")).toBeNull(); // unused chord
  });

  it("override map round-trips through localStorage (JSON serialize)", () => {
    const s1 = keybindSetting("kb.persist");
    s1.set({ "zoom.in": "Mod+Shift+=" });
    const s2 = keybindSetting("kb.persist"); // fresh read of the same key
    expect(s2.get()).toEqual({ "zoom.in": "Mod+Shift+=" });
  });
});
