import { describe, it, expect, beforeEach, vi } from "vitest";
import { defineSetting } from "../src/settings/store";
import { eventToChord } from "../src/shortcuts/keys";
import {
  registerHandler,
  bindKeybindings,
  effectiveBinding,
  findConflict,
  dispatchChord,
  allActions,
  registerCommand,
} from "../src/shortcuts/registry";

function ev(init: Partial<KeyboardEventInit> & { code: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

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

  it("⌘+ and ⌘= both dispatch zoom.in (Shift-fold alias)", () => {
    bindKeybindings(keybindSetting("kb.zoomAlias"));
    const z = vi.fn();
    registerHandler("zoom.in", z);
    expect(dispatchChord(eventToChord(ev({ metaKey: true, code: "Equal" }))!)).toBe(true); // ⌘=
    expect(dispatchChord(eventToChord(ev({ metaKey: true, shiftKey: true, code: "Equal" }))!)).toBe(true); // ⌘+
    expect(z).toHaveBeenCalledTimes(2);
  });

  it("history.back / history.forward ship with ⌘[ / ⌘]", () => {
    bindKeybindings(keybindSetting("kb.hist"));
    expect(effectiveBinding("history.back")).toBe("Mod+[");
    expect(effectiveBinding("history.forward")).toBe("Mod+]");
  });

  it("favorites.toggle ships with ⌘⇧B (paired with explorer.toggle's ⌘B)", () => {
    bindKeybindings(keybindSetting("kb.favorites"));
    expect(effectiveBinding("favorites.toggle")).toBe("Mod+Shift+B");
  });

  it("dispatchChord runs the handler bound to favorites.toggle's default chord", () => {
    bindKeybindings(keybindSetting("kb.favoritesDispatch"));
    const fn = vi.fn();
    registerHandler("favorites.toggle", fn);
    expect(dispatchChord("Mod+Shift+B")).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("override map round-trips through localStorage (JSON serialize)", () => {
    const s1 = keybindSetting("kb.persist");
    s1.set({ "zoom.in": "Mod+Shift+=" });
    const s2 = keybindSetting("kb.persist"); // fresh read of the same key
    expect(s2.get()).toEqual({ "zoom.in": "Mod+Shift+=" });
  });

  // M6-C: path.copy (⌥⌘C, document path copy) ships as Mod+Alt+C and must not
  // collide with bundle.copy's ⌘⇧C (Mod+Shift+C) — different chord, both live
  // side by side in the catalog.
  it("path.copy ships with Mod+Alt+C and does not conflict with bundle.copy's Mod+Shift+C", () => {
    bindKeybindings(keybindSetting("kb.pathCopy"));
    expect(effectiveBinding("path.copy")).toBe("Mod+Alt+C");
    expect(effectiveBinding("bundle.copy")).toBe("Mod+Shift+C");
    expect(findConflict("Mod+Alt+C")).toBe("path.copy");
    expect(findConflict("Mod+Alt+C", "path.copy")).toBeNull(); // excluded self
    expect(findConflict("Mod+Shift+C")).toBe("bundle.copy"); // unaffected sibling
  });

  it("dispatchChord runs the handler bound to path.copy's default chord", () => {
    bindKeybindings(keybindSetting("kb.pathCopyDispatch"));
    const fn = vi.fn();
    registerHandler("path.copy", fn);
    expect(dispatchChord("Mod+Alt+C")).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });
});

// Phase 1' — runtime command registration (registerCommand). SHORTCUT_ACTIONS
// itself stays a compile-time const (actions.ts unchanged); allActions() is
// the single query point that fuses it with runtimeActions so a registered
// id can actually fire (before this, a handler for an id outside the const
// catalog was registered but never matched — "half runtime").
describe("runtime commands (registerCommand)", () => {
  beforeEach(() => localStorage.clear());

  it("registers a new action id and binds its default chord", () => {
    bindKeybindings(keybindSetting("kb.rt.a"));
    const unregister = registerCommand(
      { id: "test.hello", label: "Test Hello", defaultBinding: "Mod+Shift+9" },
      () => {},
    );
    expect(effectiveBinding("test.hello")).toBe("Mod+Shift+9");
    unregister();
  });

  it("dispatchChord fires the registered handler", () => {
    bindKeybindings(keybindSetting("kb.rt.b"));
    const fn = vi.fn();
    const unregister = registerCommand(
      { id: "test.hello2", label: "Test Hello 2", defaultBinding: "Mod+Shift+8" },
      fn,
    );
    expect(dispatchChord("Mod+Shift+8")).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
    unregister();
  });

  it("findConflict reports the runtime action's chord, self-excludable", () => {
    bindKeybindings(keybindSetting("kb.rt.c"));
    const unregister = registerCommand(
      { id: "test.hello3", label: "Test Hello 3", defaultBinding: "Mod+Shift+7" },
      () => {},
    );
    expect(findConflict("Mod+Shift+7")).toBe("test.hello3");
    expect(findConflict("Mod+Shift+7", "test.hello3")).toBeNull();
    unregister();
  });

  it("a user override on the keybindingsSetting persists for a runtime action (id-keyed)", () => {
    const s = keybindSetting("kb.rt.d");
    bindKeybindings(s);
    const unregister = registerCommand(
      { id: "test.hello4", label: "Test Hello 4", defaultBinding: "Mod+Shift+6" },
      () => {},
    );
    s.set({ "test.hello4": "Mod+7" });
    expect(effectiveBinding("test.hello4")).toBe("Mod+7");
    expect(dispatchChord("Mod+7")).toBe(true);
    expect(dispatchChord("Mod+Shift+6")).toBe(false); // old default no longer mapped
    unregister();
  });

  it("demotes a conflicting default to unbound (with a warning) and leaves the built-in intact", () => {
    bindKeybindings(keybindSetting("kb.rt.e"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn();
    const unregister = registerCommand({ id: "test.clash", label: "Clash", defaultBinding: "Mod+E" }, fn);
    expect(effectiveBinding("test.clash")).toBeNull(); // demoted
    expect(effectiveBinding("mode.toggle")).toBe("Mod+E"); // built-in untouched
    expect(warn).toHaveBeenCalled();
    const modeFn = vi.fn();
    registerHandler("mode.toggle", modeFn);
    expect(dispatchChord("Mod+E")).toBe(true);
    expect(modeFn).toHaveBeenCalledOnce();
    expect(fn).not.toHaveBeenCalled(); // demoted action never got the chord
    warn.mockRestore();
    unregister();
  });

  it("fails fast on a duplicate id — a re-registration and a built-in id both throw", () => {
    bindKeybindings(keybindSetting("kb.rt.f"));
    const unregister = registerCommand({ id: "test.dup", label: "Dup", defaultBinding: null }, () => {});
    expect(() => registerCommand({ id: "test.dup", label: "Dup2", defaultBinding: null }, () => {})).toThrow();
    expect(() => registerCommand({ id: "mode.toggle", label: "Steal", defaultBinding: null }, () => {})).toThrow();
    unregister();
  });

  it("unregister is symmetric: removes from allActions, stops dispatch, frees the chord", () => {
    bindKeybindings(keybindSetting("kb.rt.g"));
    const fn = vi.fn();
    const unregister = registerCommand(
      { id: "test.temp", label: "Temp", defaultBinding: "Mod+Shift+5" },
      fn,
    );
    expect(allActions().some((a) => a.id === "test.temp")).toBe(true);
    unregister();
    expect(allActions().some((a) => a.id === "test.temp")).toBe(false);
    expect(dispatchChord("Mod+Shift+5")).toBe(false);
    expect(findConflict("Mod+Shift+5")).toBeNull();
  });

  it("a stale override for an unregistered id stays inert (no ghost firing)", () => {
    const s = keybindSetting("kb.rt.h");
    bindKeybindings(s);
    s.set({ "test.gone": "Mod+8" });
    expect(dispatchChord("Mod+8")).toBe(false);
  });
});
