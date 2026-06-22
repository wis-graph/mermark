import { describe, it, expect, beforeEach } from "vitest";
import { headingScales, headingScaleSink, cssVarSink, webFontSink } from "../src/settings/sinks";
import { googleFontHref } from "../src/settings/app";

describe("headingScales (heading typescale rule)", () => {
  it("returns six per-level scales", () => {
    expect(headingScales("1.25")).toHaveLength(6);
  });

  it("is monotonic top-down with h5 pinned to body and h6 below it", () => {
    const [s1, s2, s3, s4, s5, s6] = headingScales("1.25");
    expect(s1).toBeGreaterThan(s2);
    expect(s2).toBeGreaterThan(s3);
    expect(s3).toBeGreaterThan(s4);
    expect(s4).toBeGreaterThan(s5);
    expect(s5).toBe(1.0);
    expect(s6).toBe(0.9);
  });

  it("matches ratio^n for the upper levels (1.25 → ~1.95 h1)", () => {
    const [s1, s2, s3, s4] = headingScales("1.25");
    expect(s1).toBeCloseTo(1.25 ** 3, 5); // ≈1.953
    expect(s2).toBeCloseTo(1.25 ** 2, 5); // 1.5625
    expect(s3).toBeCloseTo(1.25 ** 1.5, 5);
    expect(s4).toBeCloseTo(1.25 ** 0.5, 5);
  });

  it("flattens contrast as the ratio shrinks (smaller ratio → smaller h1)", () => {
    expect(headingScales("1.2")[0]).toBeLessThan(headingScales("1.25")[0]);
    expect(headingScales("1.333")[0]).toBeGreaterThan(headingScales("1.25")[0]);
  });

  it("falls back to the 1.25 default on a corrupt ratio", () => {
    expect(headingScales("abc")).toEqual(headingScales("1.25"));
  });
});

describe("headingScaleSink (one ratio fans six CSS vars)", () => {
  beforeEach(() => {
    for (let n = 1; n <= 6; n++) document.documentElement.style.removeProperty(`--h${n}-scale`);
  });

  it("sets --h1-scale … --h6-scale from a single ratio in one place", () => {
    headingScaleSink()("1.25");
    const expected = headingScales("1.25");
    for (let n = 1; n <= 6; n++) {
      const v = document.documentElement.style.getPropertyValue(`--h${n}-scale`);
      expect(Number(v)).toBeCloseTo(expected[n - 1], 5);
    }
  });

  it("re-fans all six when the ratio changes", () => {
    const sink = headingScaleSink();
    sink("1.25");
    sink("1.2");
    expect(Number(document.documentElement.style.getPropertyValue("--h1-scale"))).toBeCloseTo(
      headingScales("1.2")[0],
      5,
    );
  });
});

describe("cssVarSink (reading width as ch)", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--measure");
  });

  it("formats the reading width as a ch value (P2 measure unit)", () => {
    // main.ts binds readingWidthSetting → this formatter; lock the ch unit here so
    // the px→ch unit transition can't silently regress to "68px".
    cssVarSink<number>("--measure", (ch) => `${ch}ch`)(68);
    expect(document.documentElement.style.getPropertyValue("--measure")).toBe("68ch");
  });
});

describe("webFontSink (single owner of the <head> link + --reading-font)", () => {
  const ID = "mermark-webfont";
  const link = () => document.getElementById(ID) as HTMLLinkElement | null;

  beforeEach(() => {
    link()?.remove();
    document.documentElement.style.removeProperty("--reading-font");
  });

  it("injects exactly one <link> at the googleFontHref URL and writes --reading-font", () => {
    webFontSink()({ family: "Noto Sans KR", stack: '"X", system-ui' });
    expect(link()).not.toBeNull();
    expect(link()!.href).toBe(googleFontHref("Noto Sans KR"));
    expect(document.querySelectorAll(`#${ID}`)).toHaveLength(1);
    expect(document.documentElement.style.getPropertyValue("--reading-font")).toBe('"X", system-ui');
  });

  it("replaces (keeps a single link) when the family changes — no duplicate injection", () => {
    const sink = webFontSink();
    sink({ family: "Noto Sans KR", stack: "X" });
    sink({ family: "Lato", stack: "X" });
    expect(document.querySelectorAll(`#${ID}`)).toHaveLength(1);
    expect(link()!.href).toBe(googleFontHref("Lato"));
  });

  it("removes the link when the family is empty, leaving the stack on --reading-font", () => {
    webFontSink()({ family: "Lato", stack: "X" });
    webFontSink()({ family: "", stack: "Y" });
    expect(link()).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--reading-font")).toBe("Y");
  });

  it("removes the link when the family is invalid (googleFontHref → null), still setting the stack", () => {
    webFontSink()({ family: "Lato", stack: "X" });
    webFontSink()({ family: "Roboto&evil", stack: "Z" });
    expect(link()).toBeNull(); // invalid family → no URL → no link
    expect(document.documentElement.style.getPropertyValue("--reading-font")).toBe("Z");
  });
});
