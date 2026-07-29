import { describe, it, expect } from "vitest";
import {
  epubPositionKey,
  readingPositionAt,
  restoreOffsetInChapter,
  upsertPosition,
  shouldRestorePosition,
  type EpubChapterGeom,
  type EpubReadingPosition,
} from "../src/chrome/viewer/epub-position";

// Stage P1 (_workspace/01_architect_plan_epub_position.md) — pure geometry/
// key/LRU arithmetic, no DOM/storage. Fixtures are inline objects.

describe("epubPositionKey", () => {
  it("prefers a non-blank identifier, prefixed 'id:'", () => {
    expect(epubPositionKey("urn:isbn:0-306-40615-2", "/vault/book.epub")).toBe("id:urn:isbn:0-306-40615-2");
  });

  it("falls back to the absolute path, prefixed 'path:', when identifier is null or blank", () => {
    expect(epubPositionKey(null, "/vault/book.epub")).toBe("path:/vault/book.epub");
    expect(epubPositionKey("   ", "/vault/book.epub")).toBe("path:/vault/book.epub");
  });

  it("the same identifier at a different path yields the SAME key (copy-sharing rule)", () => {
    const a = epubPositionKey("urn:isbn:xyz", "/vault/copy-a.epub");
    const b = epubPositionKey("urn:isbn:xyz", "/other/copy-b.epub");
    expect(a).toBe(b);
  });
});

const geom = (entry: string, top: number, height: number, anchors: Record<string, number> = {}): EpubChapterGeom => ({
  entry,
  top,
  height,
  anchors,
});

describe("readingPositionAt", () => {
  const geoms = [geom("ch1.xhtml", 0, 100), geom("ch2.xhtml", 100, 200), geom("ch3.xhtml", 300, 150)];

  it("selects the chapter whose span contains scrollTop (mid-chapter)", () => {
    const pos = readingPositionAt(150, geoms, 1, 1000);
    expect(pos?.entry).toBe("ch2.xhtml");
  });

  it("boundary: scrollTop exactly at a chapter's start selects THAT chapter (ratio 0)", () => {
    const pos = readingPositionAt(100, geoms, 1, 1000);
    expect(pos?.entry).toBe("ch2.xhtml");
    expect(pos?.ratio).toBe(0);
  });

  it("boundary: one pixel before the boundary selects the PREVIOUS chapter (ratio ~1)", () => {
    const pos = readingPositionAt(99, geoms, 1, 1000);
    expect(pos?.entry).toBe("ch1.xhtml");
    expect(pos?.ratio).toBeCloseTo(0.99, 5);
  });

  it("past the end of the last chapter clamps to the last chapter, ratio clamped to 1", () => {
    const pos = readingPositionAt(10000, geoms, 1, 1000);
    expect(pos?.entry).toBe("ch3.xhtml");
    expect(pos?.ratio).toBe(1);
  });

  it("ratio is dimensionless: a geom scaled 2x with a proportionally scaled scrollTop gives the same ratio", () => {
    const atZoom1Geoms = [geom("ch1.xhtml", 0, 1000), geom("ch2.xhtml", 1000, 1000)];
    const atZoom2Geoms = [geom("ch1.xhtml", 0, 2000), geom("ch2.xhtml", 2000, 2000)]; // same layout, 2x scaled
    const atZoom1 = readingPositionAt(1250, atZoom1Geoms, 1, 1000); // 0.25 into ch2
    const atZoom2 = readingPositionAt(2500, atZoom2Geoms, 2, 1000); // same 0.25 into ch2, scaled coords
    expect(atZoom1?.entry).toBe("ch2.xhtml");
    expect(atZoom2?.entry).toBe("ch2.xhtml");
    expect(atZoom1?.ratio).toBeCloseTo(atZoom2!.ratio, 5);
  });

  it("anchor: picks the id with the largest UNSCALED offset at or before the within-chapter position", () => {
    const withAnchors = [geom("ch1.xhtml", 0, 1000, { top: 0, mid: 200, late: 800 })];
    // scrollTop=250 (scaled, zoom=1) -> within-chapter unscaled offset 250 -> "mid" (200) is the closest <= 250
    const pos = readingPositionAt(250, withAnchors, 1, 1000);
    expect(pos?.anchor).toBe("mid");
  });

  it("anchor accounts for zoom when converting scaled scrollTop to unscaled chapter offset", () => {
    // zoom=2: scaled within-chapter offset 400 -> unscaled 200 -> exactly "mid"
    const withAnchors = [geom("ch1.xhtml", 0, 2000, { top: 0, mid: 200, late: 800 })];
    const pos = readingPositionAt(400, withAnchors, 2, 1000);
    expect(pos?.anchor).toBe("mid");
  });

  it("anchor is null when the chapter reports no anchors, or the position is before the first one", () => {
    const noAnchors = [geom("ch1.xhtml", 0, 100)];
    expect(readingPositionAt(50, noAnchors, 1, 1000)?.anchor).toBeNull();

    const laterAnchors = [geom("ch1.xhtml", 0, 1000, { late: 900 })];
    expect(readingPositionAt(10, laterAnchors, 1, 1000)?.anchor).toBeNull();
  });

  it("returns null for a negative scrollTop or an empty geoms array (out of the chapter stack)", () => {
    expect(readingPositionAt(-1, geoms, 1, 1000)).toBeNull();
    expect(readingPositionAt(50, [], 1, 1000)).toBeNull();
  });

  it("defaults savedAt to Date.now() when omitted", () => {
    const before = Date.now();
    const pos = readingPositionAt(50, geoms, 1);
    const after = Date.now();
    expect(pos!.savedAt).toBeGreaterThanOrEqual(before);
    expect(pos!.savedAt).toBeLessThanOrEqual(after);
  });
});

describe("restoreOffsetInChapter", () => {
  it("prefers the anchor (scaled by zoom) when it exists in the CURRENT geom's anchors", () => {
    const pos: EpubReadingPosition = { entry: "ch1.xhtml", ratio: 0.5, anchor: "mid", savedAt: 1 };
    const g = geom("ch1.xhtml", 0, 1000, { mid: 200 });
    expect(restoreOffsetInChapter(pos, g, 1)).toBe(200);
    expect(restoreOffsetInChapter(pos, g, 1.5)).toBe(300);
  });

  it("falls back to ratio × scaled height when the anchor is absent from the current geom", () => {
    const pos: EpubReadingPosition = { entry: "ch1.xhtml", ratio: 0.25, anchor: "gone", savedAt: 1 };
    const g = geom("ch1.xhtml", 0, 800, { other: 50 });
    expect(restoreOffsetInChapter(pos, g, 1)).toBe(200);
  });

  it("falls back to ratio when pos.anchor is null", () => {
    const pos: EpubReadingPosition = { entry: "ch1.xhtml", ratio: 0.5, anchor: null, savedAt: 1 };
    const g = geom("ch1.xhtml", 0, 400);
    expect(restoreOffsetInChapter(pos, g, 1)).toBe(200);
  });

  it("round-trip: save at zoom 1, restore at zoom 1.5 converges on the SAME anchor point (not a stale ratio)", () => {
    // Save: chapter is 1000px tall (scaled, zoom=1), anchor "mid" at unscaled offset 300, reader
    // stopped at scaled scrollTop 300 within the chapter.
    const savedGeom = geom("ch1.xhtml", 0, 1000, { top: 0, mid: 300, late: 900 });
    const pos = readingPositionAt(300, [savedGeom], 1, 1000)!;
    expect(pos.anchor).toBe("mid");

    // Restore at zoom 1.5: the chapter reflowed (measure.js reported new anchors/height at the new
    // zoom-narrowed width) — restoreOffsetInChapter must use the anchor, not the stale ratio, and
    // scale it by the NEW zoom.
    const restoredGeom = geom("ch1.xhtml", 0, 1500, { top: 0, mid: 320, late: 940 });
    const offset = restoreOffsetInChapter(pos, restoredGeom, 1.5);
    expect(offset).toBe(320 * 1.5);
  });
});

describe("upsertPosition", () => {
  const p = (entry: string, savedAt: number): EpubReadingPosition => ({ entry, ratio: 0, anchor: null, savedAt });

  it("updates an existing key in place without growing the map", () => {
    const map = { "id:a": p("ch1.xhtml", 1), "id:b": p("ch1.xhtml", 2) };
    const next = upsertPosition(map, "id:a", p("ch2.xhtml", 3), 100);
    expect(Object.keys(next)).toEqual(["id:a", "id:b"]);
    expect(next["id:a"].entry).toBe("ch2.xhtml");
  });

  it("adds a new key when under cap", () => {
    const next = upsertPosition({ "id:a": p("ch1.xhtml", 1) }, "id:b", p("ch1.xhtml", 2), 100);
    expect(Object.keys(next).sort()).toEqual(["id:a", "id:b"]);
  });

  it("evicts the entry with the smallest savedAt when a new key would exceed cap", () => {
    const map = { "id:old": p("ch1.xhtml", 1), "id:mid": p("ch1.xhtml", 5) };
    const next = upsertPosition(map, "id:new", p("ch1.xhtml", 10), 2);
    expect(Object.keys(next).sort()).toEqual(["id:mid", "id:new"]);
  });

  it("never mutates the input map", () => {
    const map = { "id:a": p("ch1.xhtml", 1) };
    const frozen = Object.freeze({ ...map });
    expect(() => upsertPosition(frozen, "id:b", p("ch1.xhtml", 2), 100)).not.toThrow();
    expect(Object.keys(frozen)).toEqual(["id:a"]);
  });
});

describe("shouldRestorePosition", () => {
  const spine = ["ch1.xhtml", "ch2.xhtml", "ch3.xhtml"];

  it("false when the saved entry is no longer in the spine (identifier-collision safety net)", () => {
    const pos: EpubReadingPosition = { entry: "gone.xhtml", ratio: 0.5, anchor: null, savedAt: 1 };
    expect(shouldRestorePosition(pos, spine)).toBe(false);
  });

  it("false for the first chapter at/near ratio 0 with no anchor (still at the start)", () => {
    const pos: EpubReadingPosition = { entry: "ch1.xhtml", ratio: 0.01, anchor: null, savedAt: 1 };
    expect(shouldRestorePosition(pos, spine)).toBe(false);
  });

  it("true for the first chapter if an anchor is present, even at ratio 0", () => {
    const pos: EpubReadingPosition = { entry: "ch1.xhtml", ratio: 0, anchor: "mid", savedAt: 1 };
    expect(shouldRestorePosition(pos, spine)).toBe(true);
  });

  it("true for the first chapter past the start-ratio epsilon", () => {
    const pos: EpubReadingPosition = { entry: "ch1.xhtml", ratio: 0.5, anchor: null, savedAt: 1 };
    expect(shouldRestorePosition(pos, spine)).toBe(true);
  });

  it("true for any non-first chapter, regardless of ratio", () => {
    const pos: EpubReadingPosition = { entry: "ch2.xhtml", ratio: 0, anchor: null, savedAt: 1 };
    expect(shouldRestorePosition(pos, spine)).toBe(true);
  });
});
