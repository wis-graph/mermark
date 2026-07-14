import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the Tauri invoke boundary the same way it ships: bundle_doc(path)->string.
// Each test re-points this mock to exercise success / invoke-failure paths.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { copyBundleToClipboard } from "../src/document/bundle";

const ENVELOPE = `<documents>\n<document path="note.md" title="note">\nhello\n</document>\n</documents>`;

function stubClipboard(writeText: (s: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
  });
  return (navigator.clipboard as { writeText: ReturnType<typeof vi.fn> }).writeText;
}

describe("copyBundleToClipboard", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes bundle_doc with the file path and writes the envelope to the clipboard", async () => {
    invokeMock.mockResolvedValue(ENVELOPE);
    const writeText = stubClipboard(() => Promise.resolve());

    const ok = await copyBundleToClipboard("/notes/note.md");

    expect(ok).toBe(true);
    // 3-boundary parity: arg key is `path` (single word), return is a string.
    expect(invokeMock).toHaveBeenCalledWith("bundle_doc", { path: "/notes/note.md" });
    expect(writeText).toHaveBeenCalledWith(ENVELOPE); // opaque envelope copied verbatim
  });

  it("returns false (does not throw) when bundle_doc rejects — e.g. root unreadable", async () => {
    invokeMock.mockRejectedValue("bundle read /notes/note.md: No such file");
    const writeText = stubClipboard(() => Promise.resolve());

    const ok = await copyBundleToClipboard("/notes/note.md");

    expect(ok).toBe(false);
    expect(writeText).not.toHaveBeenCalled(); // never reaches the clipboard on a failed bundle
  });

  it("returns false (does not throw) when the clipboard write is refused", async () => {
    invokeMock.mockResolvedValue(ENVELOPE);
    stubClipboard(() => Promise.reject(new Error("clipboard blocked")));

    const ok = await copyBundleToClipboard("/notes/note.md");

    expect(ok).toBe(false);
  });
});
