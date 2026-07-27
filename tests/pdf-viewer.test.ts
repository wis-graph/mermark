import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { fitWidthScale } from "../src/extensions/pdf-viewer/fit-width-scale";
import { viewerFor } from "../src/chrome/viewer/registry";
import { registerPdfViewer, ensureReadableStreamAsyncIterator } from "../src/extensions/pdf-viewer";

describe("fitWidthScale (pure — PDF fit-to-width render scale)", () => {
  // Table test (mermark-frontend §8): a table of (pageWidthPt, containerWidthPx,
  // zoomFactor) -> expected scale, no DOM/layout involved. Parameter renamed
  // from `fontScale` (full-pane rewrite, _workspace/01_architect_design.md
  // §B/§C — the 3rd argument is the viewer SHELL's local zoom
  // (`shell.zoom.get()`), never the editor's fontScale; the old name was a
  // lie post-v0.8.6's fontScale/viewer-zoom decoupling).
  const cases: Array<[number, number, number, number]> = [
    // [pageWidthPt, containerWidthPx, zoomFactor, expected]
    [612, 612, 1, 1], // US Letter width in points, container matches exactly -> scale 1
    [612, 1224, 1, 2], // container twice as wide -> scale 2
    [595.28, 892.92, 1, 1.5], // A4 width, container 1.5x -> scale 1.5
    [612, 612, 1.4, 1.4], // zoom multiplies on top of a fit-width-1 baseline
    [612, 1224, 1.4, 2.8], // both fit-width AND zoom compound
  ];

  it.each(cases)(
    "fitWidthScale(%p, %p, %p) === %p",
    (pageWidthPt, containerWidthPx, zoomFactor, expected) => {
      expect(fitWidthScale(pageWidthPt, containerWidthPx, zoomFactor)).toBeCloseTo(expected, 10);
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

  // Named contract lock (plan Stage 3 RED): a shell zoomFactor of exactly
  // 2.0 doubles the fit-to-width baseline scale — pins the "3rd argument IS
  // the viewer's zoom multiplier" contract independent of the table above,
  // so a future refactor that silently drops the multiply (e.g. reverting to
  // a fixed fontScale=1) turns this red on its own.
  it("zoomFactor 2.0 doubles the fit-to-width scale", () => {
    expect(fitWidthScale(612, 612, 2.0)).toBeCloseTo(2.0, 10);
    expect(fitWidthScale(595.28, 892.92, 2.0)).toBeCloseTo(3.0, 10); // 1.5 fit-width x2 zoom
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

describe("ensureReadableStreamAsyncIterator (WKWebView ReadableStream async-iter polyfill)", () => {
  // The production Tauri WKWebView lacks `ReadableStream.prototype[Symbol.asyncIterator]`,
  // which pdf.js's getTextContent needs (`for await (const value of readableStream)`).
  // Node/jsdom DO ship it, so we delete it to simulate the WKWebView gap, then
  // assert the polyfill restores working `for await` iteration. This is the
  // regression guard for the 0.8.4 blank-PDF fix — removing the polyfill turns
  // this red. Save/restore so no other test sees a mutated global prototype.
  const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
  const original = proto[Symbol.asyncIterator];

  function streamOf(values: number[]): ReadableStream<number> {
    return new ReadableStream<number>({
      start(controller) {
        for (const v of values) controller.enqueue(v);
        controller.close();
      },
    });
  }

  it("no-op when the engine already implements async iteration (native path preserved)", () => {
    // original is defined here (Node), so the function must NOT overwrite it.
    ensureReadableStreamAsyncIterator();
    expect(proto[Symbol.asyncIterator]).toBe(original);
  });

  it("installs a working async iterator when the engine lacks one (the WKWebView case)", async () => {
    delete proto[Symbol.asyncIterator]; // simulate WKWebView
    expect(Symbol.asyncIterator in proto).toBe(false);
    try {
      ensureReadableStreamAsyncIterator();
      expect(Symbol.asyncIterator in proto).toBe(true);

      const collected: number[] = [];
      for await (const value of streamOf([1, 2, 3])) collected.push(value);
      expect(collected).toEqual([1, 2, 3]);
    } finally {
      proto[Symbol.asyncIterator] = original; // restore native
    }
  });

  it("idempotent: a second call after installing does not replace the shim", () => {
    delete proto[Symbol.asyncIterator];
    try {
      ensureReadableStreamAsyncIterator();
      const shim = proto[Symbol.asyncIterator];
      ensureReadableStreamAsyncIterator();
      expect(proto[Symbol.asyncIterator]).toBe(shim);
    } finally {
      proto[Symbol.asyncIterator] = original;
    }
  });
});

// 재호출 4차 (팀리드 지시, 2026-07-27): pdf pages used to render as a floating
// A4 sheet — box-shadow + a 0.9-fraction reading margin — inside the column.
// The team lead asked for the same flat, borderless, edge-to-edge look the
// html/docx viewers already have, while keeping the per-page gap (pdf stays
// genuinely multi-page, unlike docx which went page-less flat the same day).
// These lock the new contract at the source level (same technique
// docx-viewer.test.ts's "flat panel-filling layout" describe block uses).
describe("pdf viewer: flat page-column layout (no page-frame shadow, full-width pages)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(ROOT, "src", "extensions", "pdf-viewer", "index.ts"), "utf8");

  it("no drop-shadow rule is injected for .pdf-viewer-page (the page-frame look is gone)", () => {
    expect(src).not.toMatch(/box-shadow:\s*0[^;]*;/);
    expect(src).toMatch(/\.pdf-viewer-page\s*\{[^}]*box-shadow:\s*none/);
  });

  it("PDF_PAGE_WIDTH_FRACTION is 1 (fills the column, no reading margin either side)", () => {
    expect(src).toMatch(/const PDF_PAGE_WIDTH_FRACTION = 1;/);
  });
});
