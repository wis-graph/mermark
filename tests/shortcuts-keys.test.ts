import { describe, it, expect } from "vitest";
import { eventToChord, parseChord, formatChord, displayChord } from "../src/shortcuts/keys";

// keys.ts is the pure serialization layer: event → canonical chord string,
// round-trip parse/format with modifier-order normalization, and platform
// display. Physical-key (e.code) based so bindings fire under non-Latin layouts.

function ev(init: Partial<KeyboardEventInit> & { code: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("eventToChord (e.code physical key)", () => {
  it("maps letter + Mod to canonical form", () => {
    expect(eventToChord(ev({ metaKey: true, code: "KeyB" }))).toBe("Mod+B");
  });
  it("includes Shift in fixed order", () => {
    expect(eventToChord(ev({ metaKey: true, shiftKey: true, code: "KeyE" }))).toBe("Mod+Shift+E");
  });
  it("maps punctuation codes to their tokens (Equal → =)", () => {
    expect(eventToChord(ev({ metaKey: true, code: "Equal" }))).toBe("Mod+=");
  });
  it("maps digit codes (Digit0 → 0)", () => {
    expect(eventToChord(ev({ metaKey: true, code: "Digit0" }))).toBe("Mod+0");
  });
  it("treats Ctrl as Mod (cross-platform primary modifier)", () => {
    expect(eventToChord(ev({ ctrlKey: true, code: "KeyB" }))).toBe("Mod+B");
  });
  it("returns null for a lone modifier press (no standalone key)", () => {
    expect(eventToChord(ev({ metaKey: true, code: "MetaLeft" }))).toBeNull();
  });
});

describe("parseChord / formatChord round-trip", () => {
  it("round-trips the canonical string", () => {
    expect(formatChord(parseChord("Mod+Shift+B")!)).toBe("Mod+Shift+B");
  });
  it("normalizes modifier order (Shift+Mod+B → Mod+Shift+B)", () => {
    expect(formatChord(parseChord("Shift+Mod+B")!)).toBe("Mod+Shift+B");
  });
  it("returns null when there is no key token (modifiers only)", () => {
    expect(parseChord("Mod")).toBeNull();
    expect(parseChord("Mod+Shift")).toBeNull();
  });
});

describe("displayChord (platform)", () => {
  it("mac uses the ⌘⇧ symbol run", () => {
    expect(displayChord("Mod+Shift+B", "mac")).toBe("⌘⇧B");
  });
  it("other uses Ctrl+Shift+ words", () => {
    expect(displayChord("Mod+Shift+B", "other")).toBe("Ctrl+Shift+B");
  });
  it("echoes invalid input unchanged (never throws)", () => {
    expect(displayChord("", "mac")).toBe("");
  });
});
