import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Tauri APIs
const onCloseRequestedMock = vi.fn();
const destroyMock = vi.fn();
const mockWindow = {
  onCloseRequested: onCloseRequestedMock,
  destroy: destroyMock,
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mockWindow,
}));

let fileText = "hello world\nline 2\nline 3\nline 4\nline 5";
let fileMtime = 12345;

const invokeMock = vi.fn((cmd: string, args?: any) => {
  if (cmd === "read_file") {
    return Promise.resolve({ text: fileText, mtime: fileMtime });
  }
  if (cmd === "write_file") {
    return Promise.resolve(fileMtime + 1);
  }
  return Promise.resolve(false);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

// main.ts subscribes to the backend's "file-changed" event (fs watcher). Stub
// the event API so boot() doesn't hit the real Tauri internals (absent in jsdom).
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

describe("Session State Persistence", () => {
  let app: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("location", {
      search: "?file=/tmp/test-doc.md",
    });
    (window as any).__TAURI_INTERNALS__ = {};

    localStorage.clear();
    onCloseRequestedMock.mockReset();
    destroyMock.mockReset();
    invokeMock.mockClear();

    app = document.createElement("div");
    app.id = "app";
    document.body.appendChild(app);
  });

  afterEach(() => {
    delete (window as any).__mermark;
    document.body.removeChild(app);
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("saves state to localStorage when cursor moves and restores it on mount", async () => {
    const sessionKey = "mermark.session./tmp/test-doc.md";
    localStorage.setItem(
      sessionKey,
      JSON.stringify({ scroll: 150, cursor: 12 }) // "line 2\n" cursor position
    );

    // Import main to trigger boot
    await import("../src/main");

    // Wait for async boot/mounting
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The editor host and bar should be appended
    const host = app.querySelector(".editor-host") as HTMLElement;
    expect(host).toBeTruthy();

    const scroller = host.querySelector(".cm-scroller") as HTMLElement;
    expect(scroller).toBeTruthy();

    // Verify restore selection
    // Since we dynamically imported main, we can access the global exposed controller in DEV mode
    const mermark = (window as any).__mermark;
    expect(mermark).toBeTruthy();
    expect(mermark.view.state.selection.main.anchor).toBe(12);

    // Verify scroll scrollTop is set in requestAnimationFrame (wait next frame)
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(scroller.scrollTop).toBe(150);

    // Trigger cursor movement to update storage
    mermark.view.dispatch({ selection: { anchor: 20 } });
    
    // Wait for the debounced saveSessionState (150ms)
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Check that localStorage got updated
    const saved = JSON.parse(localStorage.getItem(sessionKey) || "{}");
    expect(saved.cursor).toBe(20);
  });

  it("saves state to localStorage on close requested and destroys window", async () => {
    const sessionKey = "mermark.session./tmp/test-doc.md";
    
    // Import main to trigger boot
    await import("../src/main");

    // Wait for async boot/mounting
    await new Promise((resolve) => setTimeout(resolve, 100));

    const mermark = (window as any).__mermark;
    expect(mermark).toBeTruthy();

    // Set cursor position to 5
    mermark.view.dispatch({ selection: { anchor: 5 } });

    // Make an unsaved change so editor.hasUnsaved() is true
    mermark.view.dispatch({ changes: { from: 10, insert: "unsaved changes" } });

    // Verify onCloseRequested listener was registered
    expect(onCloseRequestedMock).toHaveBeenCalledTimes(1);
    const closeHandler = onCloseRequestedMock.mock.calls[0][0];

    // Trigger window close requested
    const preventDefault = vi.fn();
    await closeHandler({ preventDefault });

    // Verify that session state was saved
    const saved = JSON.parse(localStorage.getItem(sessionKey) || "{}");
    expect(saved.cursor).toBe(5);

    // Verify destroy was called
    expect(destroyMock).toHaveBeenCalled();
  });
});
