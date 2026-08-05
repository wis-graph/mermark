import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the Tauri invoke boundary the same way tests/clipboard.test.ts does:
// copy-button.ts's only clipboard path is copyTextToClipboard → invoke
// copy_to_clipboard. navigator.clipboard must never be touched.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { createCopyButton, COPY_FEEDBACK_MS } from "../src/markdown/copy-button";

describe("createCopyButton", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function stubClipboard() {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  }

  it("renders with the given label as title/aria-label and the idle copy icon", () => {
    const btn = createCopyButton("text", "인용 복사", "cm-quote-copy");
    expect(btn.title).toBe("인용 복사");
    expect(btn.getAttribute("aria-label")).toBe("인용 복사");
    expect(btn.className).toBe("cm-copy-btn cm-quote-copy");
    expect(btn.querySelector("svg.icon-copy")).not.toBeNull();
  });

  it("click invokes copy_to_clipboard with the text, never navigator.clipboard.writeText", () => {
    invokeMock.mockResolvedValue(undefined);
    const writeText = stubClipboard();
    const btn = createCopyButton("hello", "복사", "cm-x");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(invokeMock).toHaveBeenCalledWith("copy_to_clipboard", { text: "hello" });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("shows the check icon on success, then reverts to the idle label/icon after COPY_FEEDBACK_MS", async () => {
    invokeMock.mockResolvedValue(undefined);
    const btn = createCopyButton("hello", "복사", "cm-x");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(btn.querySelector("svg.icon-check")).not.toBeNull();
    expect(btn.title).toBe("복사");
    vi.advanceTimersByTime(COPY_FEEDBACK_MS);
    expect(btn.querySelector("svg.icon-copy")).not.toBeNull();
    expect(btn.title).toBe("복사");
  });

  it("shows a failure title (not silence) when the invoke rejects, then reverts", async () => {
    invokeMock.mockRejectedValue(new Error("denied"));
    const btn = createCopyButton("hello", "복사", "cm-x");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();
    expect(btn.title).toBe("복사 실패");
    vi.advanceTimersByTime(COPY_FEEDBACK_MS);
    expect(btn.title).toBe("복사");
  });

  it("mousedown/click on the button do not bubble to a host handler (no caret move / drag)", () => {
    invokeMock.mockResolvedValue(undefined);
    const btn = createCopyButton("hello", "복사", "cm-x");
    const host = document.createElement("div");
    host.appendChild(btn);
    const hostDown = vi.fn();
    host.addEventListener("mousedown", hostDown);
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(hostDown).not.toHaveBeenCalled();
  });
});
