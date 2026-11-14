import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const importSpy = vi.fn();
vi.mock("highlight.js/lib/common", async () => {
  importSpy();
  return await vi.importActual<object>("highlight.js/lib/common");
});

import {
  highlightedLines,
  loadHljs,
  highlightedLinesNow,
  resetCodeHighlightForTests,
  splitHighlightedLines,
  HIGHLIGHT_MAX_CHARS,
} from "../src/markdown/code-highlight";
import { CodeBlockWidget } from "../src/markdown/code-widget";

describe("code-highlight", () => {
  beforeEach(() => {
    resetCodeHighlightForTests();
    importSpy.mockClear();
  });

  it("block without a language never imports hljs", async () => {
    expect(await highlightedLines("", "a b c")).toBeNull();
    expect(importSpy).not.toHaveBeenCalled();
  });

  it("unknown language stays plain", async () => {
    expect(await highlightedLines("nosuchlang", "x")).toBeNull();
  });

  it("html (xml alias) highlights, and the import is cached across calls", async () => {
    const a = await highlightedLines("html", '<a href="x">y</a>');
    expect(a?.[0]).toContain("hljs-");
    await highlightedLines("js", "const a = 1;");
    expect(loadHljs()).toBe(loadHljs());
  });

  it("large block is skipped without importing", async () => {
    expect(await highlightedLines("js", "a".repeat(HIGHLIGHT_MAX_CHARS + 1))).toBeNull();
    expect(importSpy).not.toHaveBeenCalled();
  });

  it("cache returns the same array (no re-highlight)", async () => {
    const a = await highlightedLines("js", "const a = 1;");
    expect(highlightedLinesNow("js", "const a = 1;")).toBe(a);
  });

  it("splitHighlightedLines re-opens spans across lines and keeps blank lines", () => {
    expect(splitHighlightedLines('<span class="hljs-comment">a\nb</span>\n')).toEqual([
      '<span class="hljs-comment">a</span>',
      '<span class="hljs-comment">b</span>',
      "",
    ]);
  });
});

describe("CodeBlockWidget highlighting", () => {
  beforeEach(() => resetCodeHighlightForTests());

  it("renders plain first, swaps in highlight when loaded; copy text stays raw", async () => {
    const code = '<div class="a">hi</div>\n\n<b>x</b>';
    const dom = new CodeBlockWidget(code, "html").toDOM() as HTMLElement;
    expect(dom.querySelector(".hljs-name, .hljs-tag")).toBeNull();
    await highlightedLines("html", code);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(dom.querySelector(".hljs-name, .hljs-tag")).not.toBeNull();
    expect(dom.querySelectorAll(".cm-code-row").length).toBe(3);
    expect(dom.querySelector(".cm-code-row br")).not.toBeNull();
    expect(dom.querySelector("code")!.textContent).toBe(code.replace(/\n/g, ""));
    // second widget renders highlighted synchronously
    const dom2 = new CodeBlockWidget(code, "html").toDOM() as HTMLElement;
    expect(dom2.querySelector(".hljs-name, .hljs-tag")).not.toBeNull();
  });

  it("no-language block stays plain", () => {
    const dom = new CodeBlockWidget("x", "").toDOM() as HTMLElement;
    expect(dom.querySelector("[class^=hljs]")).toBeNull();
  });
});
