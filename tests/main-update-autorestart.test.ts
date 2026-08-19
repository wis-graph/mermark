import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { EditorView } from "@codemirror/view";

// Boots the real main.ts (same "import module -> boot() runs synchronously up
// to its first await" pattern as main-wiring.test.ts) and drives update-flow's
// SSOT directly (checkNow/startDownload) to verify main.ts's auto-restart
// subscriber: once a download reaches "downloaded", it should confirm the
// live buffer is saved and then install+relaunch WITHOUT a button click.
//
// Kept as its own file (not appended to main-wiring.test.ts) because it mocks
// @tauri-apps/plugin-updater / @tauri-apps/plugin-process — main-wiring.test.ts
// deliberately does not, and this suite's per-test module resets shouldn't
// bleed that mocking into that much larger, unrelated test file.
const documentContents = new Map<string, string>();
let rejectWrites = false;

const invokeMock = vi.fn((command: string, args?: unknown): Promise<unknown> => {
  const path = (args as Record<string, unknown> | undefined)?.path as string | undefined;
  if (command === "canonicalize_path") return Promise.resolve(path ?? "");
  if (command === "path_exists") return Promise.resolve(false);
  if (command === "read_file") return Promise.resolve({ text: documentContents.get(path ?? "") ?? "# doc", mtime: 1 });
  if (command === "write_file") {
    if (rejectWrites) return Promise.reject(new Error("write failed"));
    return Promise.resolve(2);
  }
  if (command === "list_dir") return Promise.resolve([]);
  if (command === "watch_file") return Promise.resolve({ path, generation: "1" });
  if (command === "unwatch_file") return Promise.resolve();
  if (command === "register_window_ready") return Promise.resolve(undefined);
  if (command === "acknowledge_open_request") return Promise.resolve(undefined);
  if (command === "list_files_recursive") return Promise.resolve({ files: [], truncated: false });
  return Promise.resolve(false);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", onCloseRequested: () => Promise.resolve(() => {}) }),
}));

// update-flow dynamic-imports these two at check/relaunch time (cold-load
// invariant, see src/update/update-flow.ts) — mocked here so this suite can
// drive real found -> downloading -> downloaded -> installing cycles.
const check = vi.fn();
const install = vi.fn(() => Promise.resolve());
const relaunch = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

function mkFoundUpdate(version = "9.9.9") {
  return {
    version,
    date: undefined as string | undefined,
    body: undefined as string | undefined,
    download: vi.fn((onEvent?: (ev: unknown) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 10 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 10 } });
      onEvent?.({ event: "Finished" });
      return Promise.resolve();
    }),
    install,
  };
}

/** Flushes pending microtask chains (commitBeforeSwitch -> installAndRelaunch
 *  is async and not awaited by the subscriber itself — main.ts fires it via
 *  `void (async () => {...})()`), same helper shape as status-bar-update.test.ts. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("main: auto-restart once an update download finishes", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { search: "?file=/doc.md" });
    localStorage.clear();
    documentContents.clear();
    documentContents.set("/doc.md", "# doc");
    rejectWrites = false;
    invokeMock.mockClear();
    check.mockReset();
    install.mockReset().mockImplementation(() => Promise.resolve());
    relaunch.mockReset().mockImplementation(() => Promise.resolve());
    const app = document.createElement("div");
    app.id = "app";
    document.body.append(app);
  });

  afterEach(() => {
    document.querySelector("#app")?.remove();
    document.querySelectorAll(".recovery-backdrop, .conflict-backdrop").forEach((el) => el.remove());
    Reflect.deleteProperty(window, "__mermark");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("installs and relaunches automatically once the download completes — no button click needed", async () => {
    check.mockResolvedValue(mkFoundUpdate());
    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("doc"));

    const flow = await import("../src/update/update-flow");
    await flow.checkNow();
    expect(flow.updatePhase()).toBe("found");
    // Not asserting an intermediate "downloaded" phase here: main.ts's
    // subscriber runs synchronously off the same setPhase("downloaded") call
    // inside startDownload, and (with no unsaved edits to flush) races ahead
    // fast enough that phase can already read "installing" the instant this
    // await settles — which IS the auto-restart behavior under test, not a
    // flake. Assert the end state after a flush instead.
    await flow.startDownload();
    await flush();
    expect(install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("confirms a pending edit is saved BEFORE auto-installing (never silently drops the buffer)", async () => {
    check.mockResolvedValue(mkFoundUpdate());
    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("doc"));
    const liveEditor = (window as Window & { readonly __mermark?: { readonly view: EditorView } }).__mermark;
    liveEditor?.view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
    invokeMock.mockClear();

    const flow = await import("../src/update/update-flow");
    await flow.checkNow();
    await flow.startDownload();
    await flush();

    const wroteBufferBeforeInstall = invokeMock.mock.calls.some(([cmd]) => cmd === "write_file");
    expect(wroteBufferBeforeInstall).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-install (or relaunch) when the pending save fails — never discards user data to force a restart", async () => {
    check.mockResolvedValue(mkFoundUpdate());
    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("doc"));
    const liveEditor = (window as Window & { readonly __mermark?: { readonly view: EditorView } }).__mermark;
    liveEditor?.view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
    rejectWrites = true;

    const flow = await import("../src/update/update-flow");
    await flow.checkNow();
    await flow.startDownload();
    await flush();

    expect(install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(flow.updatePhase()).toBe("downloaded"); // stays retryable via the manual button
  });

  it("attempts auto-install only once per download cycle — a failed install must not loop forever", async () => {
    check.mockResolvedValue(mkFoundUpdate());
    install.mockImplementation(() => Promise.reject(new Error("install failed")));
    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("doc"));

    const flow = await import("../src/update/update-flow");
    await flow.checkNow();
    await flow.startDownload();
    await flush();

    expect(install).toHaveBeenCalledTimes(1);
    // update-flow's own catch reverted the phase back to "downloaded" after
    // the failed install (see update-flow.ts's installAndRelaunch) — that
    // revert must NOT re-trigger a second auto-install pass (the infinite
    // loop this whole guard exists to prevent).
    expect(flow.updatePhase()).toBe("downloaded");
    await flush();
    await flush();
    expect(install).toHaveBeenCalledTimes(1);

    // The manual fallback button must still work after the auto-attempt failed.
    install.mockImplementation(() => Promise.resolve());
    document.querySelector<HTMLButtonElement>(".status-update-btn")?.click();
    await flush();
    expect(install).toHaveBeenCalledTimes(2);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
