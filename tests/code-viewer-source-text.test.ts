import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  looksBinary,
  decodeSourceText,
  splitLines,
  isDisplayable,
  shouldHighlight,
  sourceRenderPlan,
  splitHighlightedHtmlByLine,
  DISPLAY_MAX_BYTES,
  HIGHLIGHT_MAX_BYTES,
  HIGHLIGHT_MAX_LINES,
} from "../src/extensions/code-viewer/source-text";

// Stage B (01_architect_plan.md §1 Stage B) — pure text/binary judgment and
// line-splitting, no DOM/IO (html-viewer's prepare-html.ts precedent).

describe("looksBinary", () => {
  it("false for plain ASCII bytes", () => {
    expect(looksBinary(new Uint8Array([0x68, 0x69]))).toBe(false);
  });
  it("true when a NUL byte is present in the sniff window", () => {
    expect(looksBinary(new Uint8Array([0x68, 0x00, 0x69]))).toBe(true);
  });
  it("false for an empty array", () => {
    expect(looksBinary(new Uint8Array([]))).toBe(false);
  });
  it("false when a NUL sits just past the sniff window (index 8000)", () => {
    const bytes = new Uint8Array(8001).fill(0x61);
    bytes[8000] = 0x00;
    expect(looksBinary(bytes)).toBe(false);
  });
  it("true when a NUL sits at the last sniffed index (7999)", () => {
    const bytes = new Uint8Array(8000).fill(0x61);
    bytes[7999] = 0x00;
    expect(looksBinary(bytes)).toBe(true);
  });
  it("false for valid UTF-8 Korean bytes", () => {
    const bytes = new TextEncoder().encode("안녕하세요");
    expect(looksBinary(bytes)).toBe(false);
  });
});

describe("decodeSourceText", () => {
  it("strips a UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    expect(decodeSourceText(bytes.buffer)).toBe("a");
  });
  it("normalizes CRLF and lone CR to LF", () => {
    const bytes = new TextEncoder().encode("a\r\nb\rc");
    expect(decodeSourceText(bytes.buffer)).toBe("a\nb\nc");
  });
  it("never throws on invalid bytes — replacement character instead", () => {
    const bytes = new Uint8Array([0xff]);
    expect(() => decodeSourceText(bytes.buffer)).not.toThrow();
    expect(decodeSourceText(bytes.buffer)).toContain("�");
  });
});

describe("splitLines", () => {
  it.each([
    ["", [""]],
    ["a", ["a"]],
    ["a\n", ["a"]],
    ["a\n\n", ["a", ""]],
    ["a\nb", ["a", "b"]],
  ] as const)("splitLines(%j) === %j", (input, expected) => {
    expect(splitLines(input)).toEqual(expected);
  });
});

describe("isDisplayable", () => {
  it("true at exactly DISPLAY_MAX_BYTES", () => {
    expect(isDisplayable(DISPLAY_MAX_BYTES)).toBe(true);
  });
  it("false one byte past DISPLAY_MAX_BYTES", () => {
    expect(isDisplayable(DISPLAY_MAX_BYTES + 1)).toBe(false);
  });
});

describe("shouldHighlight", () => {
  it("true at exactly both caps", () => {
    expect(shouldHighlight(HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINES)).toBe(true);
  });
  it("false one byte past the byte cap", () => {
    expect(shouldHighlight(HIGHLIGHT_MAX_BYTES + 1, 1)).toBe(false);
  });
  it("false one line past the line cap", () => {
    expect(shouldHighlight(1, HIGHLIGHT_MAX_LINES + 1)).toBe(false);
  });
});

describe("sourceRenderPlan", () => {
  it("plain when language is null and size is small", () => {
    expect(sourceRenderPlan({ language: null, byteLength: 1, lineCount: 1 })).toBe("plain");
  });
  it("plain-too-large when a mapped language exceeds the highlight cap", () => {
    expect(
      sourceRenderPlan({ language: "typescript", byteLength: HIGHLIGHT_MAX_BYTES + 1, lineCount: 1 }),
    ).toBe("plain-too-large");
  });
  it("highlight when mapped and within caps", () => {
    expect(sourceRenderPlan({ language: "typescript", byteLength: 1, lineCount: 1 })).toBe("highlight");
  });
  it("plain-too-large when language is null AND size exceeds the highlight cap (size fact wins)", () => {
    expect(
      sourceRenderPlan({ language: null, byteLength: HIGHLIGHT_MAX_BYTES + 1, lineCount: 1 }),
    ).toBe("plain-too-large");
  });
});

describe("splitHighlightedHtmlByLine", () => {
  it.each([
    ["a\nb", ["a", "b"]],
    ["", [""]],
    ["a\n", ["a"]],
  ] as const)("splitHighlightedHtmlByLine(%j) === %j (matches splitLines' terminal-newline rule)", (input, expected) => {
    expect(splitHighlightedHtmlByLine(input)).toEqual(expected);
  });

  it("re-opens a span that crosses a newline (block-comment case)", () => {
    const html = '<span class="hljs-comment">/* x\ny */</span>';
    expect(splitHighlightedHtmlByLine(html)).toEqual([
      '<span class="hljs-comment">/* x</span>',
      '<span class="hljs-comment">y */</span>',
    ]);
  });

  it("re-opens nested spans in the correct order", () => {
    const html = '<span class="a"><span class="b">1\n2</span>3</span>';
    expect(splitHighlightedHtmlByLine(html)).toEqual([
      '<span class="a"><span class="b">1</span></span>',
      '<span class="a"><span class="b">2</span>3</span>',
    ]);
  });

  it("preserves already-escaped text content unchanged", () => {
    const html = "x &lt; y\nz";
    expect(splitHighlightedHtmlByLine(html)).toEqual(["x &lt; y", "z"]);
  });

  it("produces the same number of lines as splitLines on the real hljs output for the fixture", async () => {
    const hljs = (await import("highlight.js/lib/common")).default;
    const fixturePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "mock-assets",
      "mock",
      "vault",
      "sample.ts",
    );
    const source = readFileSync(fixturePath, "utf8").replace(/\r\n/g, "\n");
    const highlighted = hljs.highlight(source, { language: "typescript", ignoreIllegals: true }).value;
    expect(splitHighlightedHtmlByLine(highlighted).length).toBe(splitLines(source).length);
    expect(splitLines(source).length).toBe(20);
  });

  // 감사 지적(_workspace/04_audit_report.md 🟡): 종단 개행 규칙이 `html.endsWith("\n")`로
  // 재구현돼 있으면, 소스가 **열린 span 안에서** 개행으로 끝날 때(미종결 블록
  // 주석 등) hljs 출력이 태그로 끝나(`\n</span>`) `html.endsWith("\n")`가
  // false로 나와 splitLines보다 한 줄 더 많이 쪼개진다 — 이 테스트가 그
  // 불일치를 실증한다.
  it("matches splitLines' line count even when the source ends INSIDE a still-open span (unterminated block comment)", async () => {
    const hljs = (await import("highlight.js/lib/common")).default;
    const source = "a\n/* unterminated block comment\n";
    const highlighted = hljs.highlight(source, { language: "typescript", ignoreIllegals: true }).value;
    // Sanity: hljs's own output for this input really does end with a
    // closing tag, not a bare "\n" — the exact condition that broke the old
    // `html.endsWith("\n")` rule.
    expect(highlighted.endsWith("</span>")).toBe(true);
    expect(splitLines(source)).toEqual(["a", "/* unterminated block comment"]);
    expect(splitHighlightedHtmlByLine(highlighted).length).toBe(splitLines(source).length);
  });
});
