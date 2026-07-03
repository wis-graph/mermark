import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression guard for the flashStatus overlap bug (mermark M6 QA §C):
// two flashes firing within the 1200ms window used to leave the status bar
// permanently stuck on a stale flash message instead of restoring the real
// original text. Exercised through the real command dispatcher (⌥⌘C
// path.copy, ⌘⇧C bundle.copy) rather than reaching into main.ts internals,
// since flashStatus is a private closure inside boot().

const onCloseRequestedMock = vi.fn();
const destroyMock = vi.fn();
const mockWindow = {
  onCloseRequested: onCloseRequestedMock,
  destroy: destroyMock,
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mockWindow,
}));

const invokeMock = vi.fn((cmd: string, _args?: unknown) => {
  if (cmd === "read_file") return Promise.resolve({ text: "hello world", mtime: 1 });
  if (cmd === "write_file") return Promise.resolve(2);
  if (cmd === "bundle_doc") return Promise.resolve("<bundle/>");
  return Promise.resolve(false);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const clipboardWriteText = vi.fn(() => Promise.resolve());

describe("flashStatus overlap (path.copy / bundle.copy)", () => {
  let app: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("location", { search: "?file=/tmp/flash-doc.md" });
    (window as any).__TAURI_INTERNALS__ = {};
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteText },
      configurable: true,
    });
    clipboardWriteText.mockClear();
    invokeMock.mockClear();

    localStorage.clear();
    app = document.createElement("div");
    app.id = "app";
    document.body.appendChild(app);
  });

  afterEach(() => {
    delete (window as any).__mermark;
    document.body.removeChild(app);
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.useRealTimers();
  });

  it("restores the true original text after two overlapping flashes expire", async () => {
    const { dispatchChord } = await import("../src/shortcuts/registry");
    await import("../src/main");

    // Let boot() finish registering handlers and mounting.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const pos = app.querySelector(".status-pos") as HTMLElement;
    expect(pos).toBeTruthy();
    const original = pos.textContent;

    vi.useFakeTimers();

    // ⌥⌘C: path.copy — first flash of the burst, captures the real baseline.
    dispatchChord("Mod+Alt+C");
    await vi.advanceTimersByTimeAsync(0); // let the clipboard promise settle
    expect(pos.textContent).toBe("✓ 경로 복사됨");

    // Before the first flash's 1200ms timer fires, ⌘⇧C: bundle.copy overlaps.
    // Old buggy behavior: `prev` would capture "✓ 경로 복사됨" (not `original`),
    // and the first timer would still be live to stomp this one.
    await vi.advanceTimersByTimeAsync(600);
    dispatchChord("Mod+Shift+C");
    await vi.advanceTimersByTimeAsync(0);
    expect(pos.textContent).toBe("✓ 번들 복사됨");

    // Advance past where the FIRST (cancelled) timer would have fired.
    await vi.advanceTimersByTimeAsync(650);
    expect(pos.textContent).toBe("✓ 번들 복사됨"); // not stomped back to path msg

    // Advance past the second timer's expiry: must restore the real original.
    await vi.advanceTimersByTimeAsync(600);
    expect(pos.textContent).toBe(original);
  });
});
