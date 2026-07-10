import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CodeBlockWidget } from "../src/markdown/code-widget";

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
