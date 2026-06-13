import { describe, it, expect, beforeEach, vi } from "vitest";
import { defineSetting } from "../src/settings/store";

describe("defineSetting", () => {
  beforeEach(() => localStorage.clear());

  it("returns the default when nothing is stored", () => {
    const s = defineSetting({ key: "k", default: "a" });
    expect(s.get()).toBe("a");
  });

  it("reads a persisted value on construction", () => {
    localStorage.setItem("k", "b");
    const s = defineSetting({ key: "k", default: "a" });
    expect(s.get()).toBe("b");
  });

  it("falls back to default when parse rejects the stored value", () => {
    localStorage.setItem("k", "garbage");
    const s = defineSetting<"x" | "y">({
      key: "k",
      default: "x",
      parse: (r) => (r === "x" || r === "y" ? r : null),
    });
    expect(s.get()).toBe("x");
  });

  it("persists to localStorage on set", () => {
    const s = defineSetting({ key: "k", default: "a" });
    s.set("z");
    expect(localStorage.getItem("k")).toBe("z");
    expect(s.get()).toBe("z");
  });

  it("notifies subscribers on change", () => {
    const s = defineSetting({ key: "k", default: "a" });
    const seen: string[] = [];
    s.subscribe((v) => seen.push(v));
    s.set("b");
    expect(seen).toEqual(["b"]);
  });

  it("does not notify when set to the current value", () => {
    const s = defineSetting({ key: "k", default: "a" });
    const fn = vi.fn();
    s.subscribe(fn);
    s.set("a");
    expect(fn).not.toHaveBeenCalled();
  });

  it("subscribe is change-only (no immediate fire)", () => {
    const s = defineSetting({ key: "k", default: "a" });
    const fn = vi.fn();
    s.subscribe(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("bind fires immediately with the current value, then on change", () => {
    localStorage.setItem("k", "b");
    const s = defineSetting({ key: "k", default: "a" });
    const seen: string[] = [];
    s.bind((v) => seen.push(v));
    expect(seen).toEqual(["b"]);
    s.set("c");
    expect(seen).toEqual(["b", "c"]);
  });

  it("unsubscribe stops further notifications", () => {
    const s = defineSetting({ key: "k", default: "a" });
    const fn = vi.fn();
    const off = s.subscribe(fn);
    off();
    s.set("b");
    expect(fn).not.toHaveBeenCalled();
  });

  it("uses serialize when persisting", () => {
    const s = defineSetting<{ n: number }>({
      key: "k",
      default: { n: 0 },
      parse: (r) => (r ? (JSON.parse(r) as { n: number }) : null),
      serialize: JSON.stringify,
    });
    s.set({ n: 5 });
    expect(localStorage.getItem("k")).toBe('{"n":5}');
  });
});
