import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { docxContainerKind } from "../src/extensions/docx-viewer/container-kind";
import { viewerFor } from "../src/chrome/viewer/registry";
import { registerDocxViewer, docxOpenErrorMessage } from "../src/extensions/docx-viewer";

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

// 재호출 3차 (팀리드 지시, 2026-07-27): the docx viewer used to render a
// floating A4 "page" — box-shadow + a 0.9-fraction fit-to-width scale — inside
// the panel, framed like a photo. The user asked for the html-viewer's flat,
// borderless, panel-filling layout instead. These lock the new contract at
// the source level (same technique as the describe block above): no shadow
// rule survives, and the three inline sectPr properties docx-preview writes
// onto `section.docx` (measured in the real app via aside MCP: `padding:
// 70.85pt; width: 595.3pt; min-height: 841.9pt;`) are overridden so the
// section fills the panel instead of floating at its own native size.
describe("docx viewer: flat panel-filling layout (no page frame)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(ROOT, "src", "extensions", "docx-viewer", "index.ts"), "utf8");

  it("no box-shadow rule is injected for section.docx (the page-frame look is gone)", () => {
    expect(src).not.toMatch(/box-shadow:\s*0[^;]*;/);
    expect(src).toMatch(/box-shadow:\s*none/);
  });

  it("section.docx's inline width/min-height are overridden with !important (beats docx-preview's own inline style)", () => {
    expect(src).toMatch(/width:\s*100%\s*!important/);
    expect(src).toMatch(/min-height:\s*0\s*!important/);
  });

  it("no fit-to-width scale machinery remains (the page-fraction fit this superseded)", () => {
    expect(src).not.toMatch(/docxFitScale|nativePageWidth|refitDocx|DOCX_PAGE_WIDTH_FRACTION/);
  });
});
