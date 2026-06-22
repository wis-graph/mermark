import { describe, it, expect } from "vitest";
import { foldMarkerDOM } from "../src/markdown/fold";

describe("foldMarkerDOM", () => {
  it("renders a single chevron SVG (open)", () => {
    const el = foldMarkerDOM(true);
    expect(el.querySelector("svg")).not.toBeNull();
    expect(el.querySelectorAll("svg").length).toBe(1);
    expect(el.querySelector("svg path")).not.toBeNull();
  });

  it("uses class toggling, not glyph swap: open has no -closed class", () => {
    const el = foldMarkerDOM(true);
    expect(el.classList.contains("cm-fold-marker")).toBe(true);
    expect(el.classList.contains("cm-fold-marker-closed")).toBe(false);
  });

  it("closed adds the -closed class (CSS rotates the same SVG)", () => {
    const el = foldMarkerDOM(false);
    expect(el.classList.contains("cm-fold-marker")).toBe(true);
    expect(el.classList.contains("cm-fold-marker-closed")).toBe(true);
  });

  it("GLYPH GUARD: no ▾/▸ text glyph leaks in (chevron is an SVG, not a glyph)", () => {
    expect(foldMarkerDOM(true).textContent ?? "").not.toContain("▾");
    expect(foldMarkerDOM(true).textContent ?? "").not.toContain("▸");
    expect(foldMarkerDOM(false).textContent ?? "").not.toContain("▾");
    expect(foldMarkerDOM(false).textContent ?? "").not.toContain("▸");
  });

  it("keeps the Korean fold/unfold title", () => {
    expect(foldMarkerDOM(true).title).toBe("접기");
    expect(foldMarkerDOM(false).title).toBe("펼치기");
  });

  it("renders the same chevron path regardless of open state (rotation, not swap)", () => {
    const openPath = foldMarkerDOM(true).querySelector("svg path")?.getAttribute("d");
    const closedPath = foldMarkerDOM(false).querySelector("svg path")?.getAttribute("d");
    expect(openPath).toBe(closedPath);
    expect(openPath).toBeTruthy();
  });
});
