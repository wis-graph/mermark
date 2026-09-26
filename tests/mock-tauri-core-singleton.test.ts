// D2 (_workspace/01_architect_design.md §4.2 H2) regression tripwire: a
// second instance of src/mocks/tauri-core.ts booting (e.g. because Vite's
// dep optimizer pre-bundled a @tauri-apps/plugin-* package and inlined its
// OWN copy of the aliased module into a shared chunk) silently stomps
// window.__mockInvoke/__mockCurrentWatchSession with an empty store — the
// running app keeps using the FIRST instance while any golden/CDP script
// reading those globals off `window` talks to the disconnected second one.
// This guards that the mock itself screams about it via console.error, so
// workspace-smoke's console collection can fail the run instead of quietly
// reading a broken mock (H2 in _workspace/01_architect_design.md's
// diagnosis).
import { afterEach, describe, expect, it, vi } from "vitest";

describe("tauri-core mock duplicate-instance tripwire", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__mockInvoke");
    Reflect.deleteProperty(window, "__mockCurrentWatchSession");
  });

  it("logs [mock] duplicate tauri-core instance when a second module instance boots after window.__mockInvoke is already set", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("../src/mocks/tauri-core");
    expect(errorSpy).not.toHaveBeenCalled(); // first boot: nothing was set yet, no complaint

    vi.resetModules(); // simulate a second, independent module instantiation
    await import("../src/mocks/tauri-core");

    const duplicateLogged = errorSpy.mock.calls.some(
      ([message]) => typeof message === "string" && message.includes("[mock] duplicate tauri-core instance"),
    );
    expect(duplicateLogged).toBe(true);
  });
});
