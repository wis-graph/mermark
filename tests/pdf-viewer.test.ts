import { describe, it, expect } from "vitest";
import { fitWidthScale } from "../src/extensions/pdf-viewer/fit-width-scale";
import { viewerFor } from "../src/chrome/viewer/registry";
import { registerPdfViewer } from "../src/extensions/pdf-viewer";

describe("fitWidthScale (pure — PDF fit-to-width render scale)", () => {
  // Table test (mermark-frontend §8): a table of (pageWidthPt, containerWidthPx,
  // fontScale) -> expected scale, no DOM/layout involved.
  const cases: Array<[number, number, number, number]> = [
    // [pageWidthPt, containerWidthPx, fontScale, expected]
    [612, 612, 1, 1], // US Letter width in points, container matches exactly -> scale 1
    [612, 1224, 1, 2], // container twice as wide -> scale 2
    [595.28, 892.92, 1, 1.5], // A4 width, container 1.5x -> scale 1.5
    [612, 612, 1.4, 1.4], // zoom multiplies on top of a fit-width-1 baseline
    [612, 1224, 1.4, 2.8], // both fit-width AND zoom compound
  ];

  it.each(cases)(
    "fitWidthScale(%p, %p, %p) === %p",
    (pageWidthPt, containerWidthPx, fontScale, expected) => {
      expect(fitWidthScale(pageWidthPt, containerWidthPx, fontScale)).toBeCloseTo(expected, 10);
    },
  );

  it("degenerate: a zero/negative page width falls back to the bare zoom factor (never NaN/Infinity)", () => {
    expect(fitWidthScale(0, 800, 1.2)).toBe(1.2);
    expect(fitWidthScale(-10, 800, 1.2)).toBe(1.2);
  });

  it("degenerate: a zero/negative container width falls back to the bare zoom factor", () => {
    expect(fitWidthScale(612, 0, 1.2)).toBe(1.2);
    expect(fitWidthScale(612, -1, 1.2)).toBe(1.2);
  });
});

describe("PDF viewer registration", () => {
  it("registerPdfViewer() claims \"pdf\" — viewerFor(\"pdf\") resolves to id \"ext.pdf\"", () => {
    registerPdfViewer();
    const viewer = viewerFor("pdf");
    expect(viewer).not.toBeNull();
    expect(viewer?.id).toBe("ext.pdf");
    expect(viewer?.extensions).toContain("pdf");
  });

  it("a second registerPdfViewer() call throws (registerViewer's own duplicate-id guard)", () => {
    // registerPdfViewer() already ran once in the previous test (module-level
    // registry state persists across tests in the same file, same pattern
    // hwp-viewer/excel-viewer registration tests already rely on).
    expect(() => registerPdfViewer()).toThrow(/already registered/);
  });
});
