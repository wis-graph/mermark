import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { docxContainerKind } from "../src/extensions/docx-viewer/container-kind";
import { viewerFor } from "../src/chrome/viewer/registry";
import { registerDocxViewer, docxOpenErrorMessage } from "../src/extensions/docx-viewer";
import { docxFitScale, DOCX_PAGE_WIDTH_FRACTION } from "../src/extensions/docx-viewer/fit-scale";

function bytesOf(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe("docxContainerKind (pure — zip/CFB/unknown signature classifier)", () => {
  // Table test (mermark-frontend §8), mirrors pdf-viewer.test.ts's
  // fitWidthScale table shape.
  it("a zip local-file-header signature (50 4B 03 04 ...) -> \"zip\"", () => {
    expect(docxContainerKind(bytesOf(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00))).toBe("zip");
  });

  it("the CFB/OLE2 magic (D0 CF 11 E0 A1 B1 1A E1) -> \"cfb\"", () => {
    expect(docxContainerKind(bytesOf(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe("cfb");
  });

  it("arbitrary text bytes -> \"unknown\"", () => {
    const text = new TextEncoder().encode("not a docx at all, just text");
    expect(docxContainerKind(text.buffer as ArrayBuffer)).toBe("unknown");
  });

  it("a buffer shorter than any signature -> \"unknown\" (never throws)", () => {
    expect(docxContainerKind(bytesOf())).toBe("unknown");
    expect(docxContainerKind(bytesOf(0x50, 0x4b))).toBe("unknown");
  });

  it("empty ArrayBuffer -> \"unknown\" (never throws)", () => {
    expect(docxContainerKind(new ArrayBuffer(0))).toBe("unknown");
  });
});

describe("docxFitScale (pure — page-width-parity fit ratio, mirrors pdf-viewer's fitWidthScale table)", () => {
  it(`fits a 793.7px page into ${DOCX_PAGE_WIDTH_FRACTION * 100}% of a 1050px available width`, () => {
    // Real measured numbers from the browser-mode repro (1050 clientWidth /
    // 793.7 section.docx width, 76% before this fix) — after the fix the
    // page should scale to exactly DOCX_PAGE_WIDTH_FRACTION of 1050.
    expect(docxFitScale(1050, 793.7)).toBeCloseTo((1050 * DOCX_PAGE_WIDTH_FRACTION) / 793.7, 10);
  });

  it("a wider available width scales the page UP", () => {
    expect(docxFitScale(2000, 793.7)).toBeGreaterThan(1);
  });

  it("a narrower available width scales the page DOWN", () => {
    expect(docxFitScale(400, 793.7)).toBeLessThan(1);
  });

  it("zero page width -> 1 (safe default, never divides by zero)", () => {
    expect(docxFitScale(1050, 0)).toBe(1);
  });

  it("NaN page width -> 1 (safe default, never propagates NaN)", () => {
    expect(docxFitScale(1050, NaN)).toBe(1);
  });

  it("zero available width -> 1 (safe default)", () => {
    expect(docxFitScale(0, 793.7)).toBe(1);
  });

  it("negative available width -> 1 (safe default)", () => {
    expect(docxFitScale(-100, 793.7)).toBe(1);
  });

  it("NaN available width -> 1 (safe default)", () => {
    expect(docxFitScale(NaN, 793.7)).toBe(1);
  });
});

describe("docx viewer registration", () => {
  it('registerDocxViewer() claims "docx" — viewerFor("docx") resolves to id "ext.docx"', () => {
    registerDocxViewer();
    const viewer = viewerFor("docx");
    expect(viewer).not.toBeNull();
    expect(viewer?.id).toBe("ext.docx");
    expect(viewer?.extensions).toContain("docx");
    expect(viewer?.label).toBeTruthy();
  });

  it("a second registerDocxViewer() call throws (registerViewer's own duplicate-id guard)", () => {
    // registerDocxViewer() already ran once in the previous test (module-level
    // registry state persists across tests in the same file, same pattern
    // pdf-viewer.test.ts/excel-viewer registration tests already rely on).
    expect(() => registerDocxViewer()).toThrow(/already registered/);
  });

  it('does NOT claim "doc" — docx-preview cannot read a legacy CFB container', () => {
    // registerDocxViewer() already ran above; a fresh viewerFor query is
    // enough, no re-registration needed.
    const viewer = viewerFor("doc");
    expect(viewer?.id).not.toBe("ext.docx");
  });
});

describe("docxOpenErrorMessage (named error-message rule, design §핵심 판정 3)", () => {
  it('"cfb" -> the legacy/encrypted-doc message', () => {
    expect(docxOpenErrorMessage("cfb")).toContain("구형 .doc 형식이거나 암호로 보호된 문서입니다");
  });

  it('"unknown" -> the not-a-docx message', () => {
    expect(docxOpenErrorMessage("unknown")).toContain(".docx 형식이 아닙니다");
  });

  it('"zip" + an Error -> the error\'s own message, "문서를 열 수 없습니다:" prefixed', () => {
    const msg = docxOpenErrorMessage("zip", new Error("Corrupted zip: missing central directory"));
    expect(msg).toContain("문서를 열 수 없습니다:");
    expect(msg).toContain("Corrupted zip: missing central directory");
  });

  it('"zip" + a non-Error value -> String(err), still prefixed', () => {
    const msg = docxOpenErrorMessage("zip", "raw string failure");
    expect(msg).toContain("문서를 열 수 없습니다:");
    expect(msg).toContain("raw string failure");
  });

  it('"zip" with no err at all -> a generic message, never the literal "undefined"', () => {
    const msg = docxOpenErrorMessage("zip");
    expect(msg).toContain("문서를 열 수 없습니다:");
    expect(msg).not.toContain("undefined");
  });
});

// Regression guard for 04_audit_report.md's blocker: openDocxViewer() used to
// swap `content` for an UNSTYLED wrapper div (`.docx-viewer-pages-host`) that
// held the real scroll container (`.docx-viewer-pages`) as a child — a THIRD
// layer between the shell's `.viewer-panel-body` (flex:1; overflow:hidden)
// and the scroll box, whose own `flex:1` was inert with no CSS backing it,
// silently clipping any docx taller than one screen with no scrollbar to
// reach the rest. The fix collapses this back to the two-layer contract
// every other document viewer here uses (pdf-viewer.ts:
// `content.className = "pdf-viewer-pages"`, hwp-viewer identical): `content`
// itself (openViewerShell's own scroll boundary child) becomes the scroll
// container, not a wrapper OF one. A full DOM mount isn't needed to pin this
// (docx-preview would need a real dynamic import + fixture bytes) — the
// STRUCTURAL contract is verifiable straight from source, the same
// technique tests/viewer-size-envelope.test.ts already uses for CSS
// contracts in this same file tree.
describe("docx viewer: content IS the scroll container (no third wrapper layer)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(ROOT, "src", "extensions", "docx-viewer", "index.ts"), "utf8");

  it('the loaded state assigns "docx-viewer-pages" directly onto `content` (not a child wrapper)', () => {
    expect(src).toMatch(/content\.className\s*=\s*["']docx-viewer-pages["']/);
  });

  it("no intermediate wrapper class (the regressed shape) is reintroduced", () => {
    expect(src).not.toMatch(/docx-viewer-pages-host/);
  });

  it("the zoom sink writes to `content.style.zoom` — the SAME element as the scroll container", () => {
    expect(src).toMatch(/content\.style\.zoom\s*=/);
  });
});
