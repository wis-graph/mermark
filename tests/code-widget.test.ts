import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CodeBlockWidget, codeHangCh } from "../src/markdown/code-widget";

function stubClipboard(writeText: (s: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
  });
  return (navigator.clipboard as { writeText: ReturnType<typeof vi.fn> }).writeText;
}

describe("CodeBlockWidget copy button", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders an icon-only copy button in the top-right of the block", () => {
    const dom = new CodeBlockWidget("const a = 1;", "ts").toDOM();
    const btn = dom.querySelector<HTMLButtonElement>(".cm-codeblock-copy");
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-label")).toBe("코드 복사");
    expect(btn?.title).toBe("코드 복사");
    expect(btn?.querySelector("svg.icon-copy")).not.toBeNull();
  });

  it("copies the fenced source (not fence markers) verbatim on click", () => {
    const writeText = stubClipboard(() => Promise.resolve());
    const widget = new CodeBlockWidget("const a = 1;\nconst b = 2;", "ts");
    const dom = widget.toDOM();
    const btn = dom.querySelector<HTMLButtonElement>(".cm-codeblock-copy")!;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(writeText).toHaveBeenCalledWith("const a = 1;\nconst b = 2;");
  });

  it("swaps the icon to check on success, then reverts after the feedback window", async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    const dom = new CodeBlockWidget("x", "").toDOM();
    const btn = dom.querySelector<HTMLButtonElement>(".cm-codeblock-copy")!;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    await Promise.resolve(); // let the resolved clipboard promise's .then run
    expect(btn.querySelector("svg.icon-check")).not.toBeNull();
    vi.advanceTimersByTime(1500);
    expect(btn.querySelector("svg.icon-copy")).not.toBeNull();
    expect(btn.title).toBe("코드 복사");
  });

  it("shows a failure title (not silence) when the clipboard write is refused", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    const dom = new CodeBlockWidget("x", "").toDOM();
    const btn = dom.querySelector<HTMLButtonElement>(".cm-codeblock-copy")!;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(btn.title).toBe("복사 실패");
    vi.advanceTimersByTime(1500);
    expect(btn.title).toBe("코드 복사");
  });

  it("mousedown on the button is swallowed (does not bubble to a host drag handler)", () => {
    const dom = new CodeBlockWidget("x", "").toDOM();
    const btn = dom.querySelector<HTMLButtonElement>(".cm-codeblock-copy")!;
    const hostDown = vi.fn();
    dom.addEventListener("mousedown", hostDown);
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(hostDown).not.toHaveBeenCalled();
  });

  it("ignoreEvent tells CM to leave copy-button events alone, but not other clicks", () => {
    const widget = new CodeBlockWidget("const a = 1;", "ts");
    const dom = widget.toDOM();
    const btn = dom.querySelector<HTMLButtonElement>(".cm-codeblock-copy")!;
    const code = dom.querySelector("code")!;
    expect(widget.ignoreEvent({ target: btn } as unknown as Event)).toBe(true);
    expect(widget.ignoreEvent({ target: code } as unknown as Event)).toBe(false);
  });
});

describe("codeHangCh (soft-wrap hanging-indent rule: leading whitespace width + 2)", () => {
  it("no leading whitespace → 2ch (the standard 2-space hang)", () => {
    expect(codeHangCh("x")).toBe(2);
  });

  it("4 leading spaces → 6ch", () => {
    expect(codeHangCh("    x")).toBe(6);
  });

  it("a leading tab counts as 2ch", () => {
    expect(codeHangCh("\tx")).toBe(4);
  });

  it("mixed leading tab + spaces", () => {
    expect(codeHangCh("\t  x")).toBe(6); // tab(2) + 2 spaces(2) + 2
  });

  it("an all-whitespace line still returns a finite hang (no infinite scan)", () => {
    expect(codeHangCh("    ")).toBe(6);
  });
});

describe("CodeBlockWidget per-row rendering (soft-wrap hanging indent)", () => {
  it("renders one .cm-code-row per source line", () => {
    const dom = new CodeBlockWidget("a\n  b", "ts").toDOM();
    const rows = dom.querySelectorAll(".cm-code-row");
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toBe("a");
    expect(rows[1]!.textContent).toBe("  b");
  });

  it("each row's --code-hang custom property matches codeHangCh of that line", () => {
    const dom = new CodeBlockWidget("a\n  b", "ts").toDOM();
    const rows = dom.querySelectorAll<HTMLElement>(".cm-code-row");
    expect(rows[0]!.style.getPropertyValue("--code-hang")).toBe(`${codeHangCh("a")}ch`);
    expect(rows[1]!.style.getPropertyValue("--code-hang")).toBe(`${codeHangCh("  b")}ch`);
  });

  it("gives a blank source line its own row with a <br> (line-box guard against 0-height collapse)", () => {
    const dom = new CodeBlockWidget("line1\n\nline2", "ts").toDOM();
    const rows = dom.querySelectorAll<HTMLElement>(".cm-code-row");
    // 2026-07-12 audit fix: a content-less block-level span has no line box
    // and renders at 0 height — the blank source line would otherwise vanish
    // visually in read mode (a regression from the old single-textContent+
    // pre-wrap render, which preserved blank lines for free).
    expect(rows.length).toBe(3);
    expect(rows[0]!.textContent).toBe("line1");
    expect(rows[1]!.textContent).toBe(""); // blank line: no text …
    expect(rows[1]!.querySelector("br")).not.toBeNull(); // … but a <br> line-box guard
    expect(rows[2]!.textContent).toBe("line2");
  });

  it("does not add a stray <br> to a non-blank row", () => {
    const dom = new CodeBlockWidget("a\n  b", "ts").toDOM();
    const rows = dom.querySelectorAll<HTMLElement>(".cm-code-row");
    expect(rows[0]!.querySelector("br")).toBeNull();
    expect(rows[1]!.querySelector("br")).toBeNull();
  });

  it("copy button still copies the ORIGINAL multi-line source verbatim (row split is toDOM-only)", () => {
    const writeText = stubClipboard(() => Promise.resolve());
    const widget = new CodeBlockWidget("a\n  b\nc", "ts");
    const dom = widget.toDOM();
    const btn = dom.querySelector<HTMLButtonElement>(".cm-codeblock-copy")!;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(writeText).toHaveBeenCalledWith("a\n  b\nc");
  });
});
