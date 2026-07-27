import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the Tauri invoke boundary the same way it ships: copy_to_clipboard(text)->void.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { copyTextToClipboard } from "../src/clipboard";

function stubClipboard() {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe("copyTextToClipboard", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes copy_to_clipboard with the text and resolves true, never touching navigator.clipboard", async () => {
    invokeMock.mockResolvedValue(undefined);
    const writeText = stubClipboard();

    const ok = await copyTextToClipboard("x");

    expect(ok).toBe(true);
    // 3-boundary parity: arg key is `text` (single word, snake/camel-agnostic).
    expect(invokeMock).toHaveBeenCalledWith("copy_to_clipboard", { text: "x" });
    expect(writeText).not.toHaveBeenCalled(); // single IPC path, no web fallback
  });

  it("returns false (does not throw) when the invoke rejects", async () => {
    invokeMock.mockRejectedValue("clipboard write failed: permission denied");
    const writeText = stubClipboard();

    const ok = await copyTextToClipboard("x");

    expect(ok).toBe(false);
    expect(writeText).not.toHaveBeenCalled(); // no fallback retry via the web API
  });
});
