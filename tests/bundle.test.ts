import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the Tauri invoke boundary the same way it ships: bundle_doc(path)->string,
// then copy_to_clipboard(text)->void. Each test re-points this mock to exercise
// success / invoke-failure paths at either hop.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { copyBundleToClipboard } from "../src/document/bundle";

const ENVELOPE = `<documents>\n<document path="note.md" title="note">\nhello\n</document>\n</documents>`;

function stubClipboard() {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe("copyBundleToClipboard", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes bundle_doc then copy_to_clipboard with the envelope verbatim, never touching navigator.clipboard", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "bundle_doc" ? Promise.resolve(ENVELOPE) : Promise.resolve(undefined),
    );
    const writeText = stubClipboard();

    const ok = await copyBundleToClipboard("/notes/note.md");

    expect(ok).toBe(true);
    // 3-boundary parity: bundle_doc's arg key is `path`, copy_to_clipboard's is `text`.
    expect(invokeMock).toHaveBeenNthCalledWith(1, "bundle_doc", { path: "/notes/note.md" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "copy_to_clipboard", { text: ENVELOPE });
    expect(writeText).not.toHaveBeenCalled(); // single IPC path, no web fallback
  });

  it("returns false (does not throw) when bundle_doc rejects — e.g. root unreadable", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "bundle_doc"
        ? Promise.reject("bundle read /notes/note.md: No such file")
        : Promise.resolve(undefined),
    );

    const ok = await copyBundleToClipboard("/notes/note.md");

    expect(ok).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1); // never reaches copy_to_clipboard on a failed bundle
  });

  it("returns false (does not throw) when copy_to_clipboard rejects", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "bundle_doc" ? Promise.resolve(ENVELOPE) : Promise.reject("clipboard blocked"),
    );

    const ok = await copyBundleToClipboard("/notes/note.md");

    expect(ok).toBe(false);
  });
});
