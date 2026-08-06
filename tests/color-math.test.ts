import { describe, it, expect } from "vitest";
import { contrastRatio, hexToHsl, hslToHex } from "../src/settings/panel/color-math";

describe("hexToHsl / hslToHex round-trip", () => {
  it.each([
    ["#000000", { h: 0, s: 0, l: 0 }],
    ["#ffffff", { h: 0, s: 0, l: 100 }],
    ["#cc785c", { h: 15, s: 52.34, l: 58.04 }],
  ] as const)("converts %s to the expected HSL", (hex, expected) => {
    const hsl = hexToHsl(hex);
    expect(hsl.h).toBeCloseTo(expected.h, 1);
    expect(hsl.s).toBeCloseTo(expected.s, 1);
    expect(hsl.l).toBeCloseTo(expected.l, 1);
  });

  it.each(["#000000", "#ffffff", "#cc785c", "#8f887e"])(
    "round-trips %s through hexToHsl -> hslToHex unchanged",
    (hex) => {
      expect(hslToHex(hexToHsl(hex))).toBe(hex);
    },
  );

  it("expands 3-digit hex the same as its 6-digit equivalent", () => {
    expect(hexToHsl("#0f0")).toEqual(hexToHsl("#00ff00"));
  });

  it("handles boundary H=360 (wraps to 0) and S=0 (achromatic, H undefined-but-stable)", () => {
    // Pure gray: max===min so d===0, h/s both fall to 0 — a stable, sane result
    // rather than NaN from a 0/0 division.
    const gray = hexToHsl("#808080");
    expect(gray.h).toBe(0);
    expect(gray.s).toBe(0);
    expect(gray.l).toBeCloseTo(50.2, 0);

    // h=360 and h=0 must resolve to the same hex (hue wheel wraps).
    expect(hslToHex({ h: 360, s: 100, l: 50 })).toBe(hslToHex({ h: 0, s: 100, l: 50 }));
  });
});

describe("contrastRatio", () => {
  it("black vs white is the maximum WCAG ratio, 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  it("is order-independent", () => {
    expect(contrastRatio("#8f887e", "#f5f5f5")).toBeCloseTo(contrastRatio("#f5f5f5", "#8f887e"), 6);
  });

  it("a color against itself is always 1:1", () => {
    expect(contrastRatio("#cc785c", "#cc785c")).toBeCloseTo(1, 6);
  });

  it("matches the known light-preset comment:bg pair (~4.4 muted, ~3.2 comment)", () => {
    // #777169 is the light preset's --muted; #8f887e is its new --comment.
    expect(contrastRatio("#777169", "#f5f5f5")).toBeCloseTo(4.4, 1);
    expect(contrastRatio("#8f887e", "#f5f5f5")).toBeCloseTo(3.2, 1);
  });
});
