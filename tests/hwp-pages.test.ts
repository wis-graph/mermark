import { describe, it, expect } from "vitest";
import { svgToDataUrl, pageAspectFrom, isNearViewport, pagePlaceholder } from "../src/chrome/viewer/hwp-pages";

// Pure transform layer for the HWP viewer (_workspace/01_hwp_viewer.md §4.3,
// §8 F-2). No invoke, no DOM mount beyond the detached element
// pagePlaceholder constructs — mirrors prepare-html.test.ts's shape for the
// HTML viewer's own pure-function file.

describe("svgToDataUrl", () => {
  it("wraps an SVG string as a data:image/svg+xml;base64 URL", () => {
    const url = svgToDataUrl("<svg></svg>");
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  it("round-trips UTF-8 (Korean) text through base64 without mangling", () => {
    const svg = '<svg><text>한글 문서 테스트</text></svg>';
    const url = svgToDataUrl(svg);
    const base64 = url.slice("data:image/svg+xml;base64,".length);
    const decoded = decodeURIComponent(escape(atob(base64)));
    expect(decoded).toBe(svg);
  });
});

describe("pageAspectFrom", () => {
  it("computes width/height from the SVG root's declared attributes", () => {
    const aspect = pageAspectFrom('<svg xmlns="http://www.w3.org/2000/svg" width="595" height="842"><text/></svg>');
    expect(aspect).toBeCloseTo(595 / 842, 10);
  });

  it("returns null when width is missing", () => {
    expect(pageAspectFrom('<svg height="842"></svg>')).toBeNull();
  });

  it("returns null when height is missing", () => {
    expect(pageAspectFrom('<svg width="595"></svg>')).toBeNull();
  });

  it("returns null when there is no <svg> tag at all", () => {
    expect(pageAspectFrom("not an svg")).toBeNull();
  });

  it("returns null for a non-numeric or zero dimension", () => {
    expect(pageAspectFrom('<svg width="abc" height="842"></svg>')).toBeNull();
    expect(pageAspectFrom('<svg width="0" height="842"></svg>')).toBeNull();
  });
});

describe("isNearViewport", () => {
  it("mirrors entry.isIntersecting", () => {
    expect(isNearViewport({ isIntersecting: true })).toBe(true);
    expect(isNearViewport({ isIntersecting: false })).toBe(false);
  });
});

describe("pagePlaceholder", () => {
  it("builds a .hwp-viewer-page div with data-page and the A4 default aspect ratio", () => {
    const el = pagePlaceholder(2);
    expect(el.className).toBe("hwp-viewer-page");
    expect(el.dataset.page).toBe("2");
    // jsdom's CSSOM normalizes a bare number to an "N / 1" aspect-ratio
    // serialization — assert on the SOURCE value pagePlaceholder sets, not
    // jsdom's re-serialized form (same lesson html-viewer.test.ts's T5 notes
    // for calc() folding).
    expect(el.style.aspectRatio).toBe(`${210 / 297} / 1`);
  });

  it("each call returns a fresh, unattached element", () => {
    const a = pagePlaceholder(0);
    const b = pagePlaceholder(0);
    expect(a).not.toBe(b);
    expect(a.isConnected).toBe(false);
  });
});
