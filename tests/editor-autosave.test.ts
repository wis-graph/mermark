import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Controllable invoke: read_file → {text,mtime}; write_file routes through a
// per-test handler so a CONFLICT can be simulated; everything else → false.
let writeHandler: (args: { path: string; text: string; baseline: number }) => Promise<number>;
const invokeMock = vi.fn((cmd: string, args?: unknown) => {
  if (cmd === "read_file") return Promise.resolve({ text: "", mtime: 1 });
  if (cmd === "write_file")
    return writeHandler(args as { path: string; text: string; baseline: number });
  return Promise.resolve(false);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

import { mountEditor, shouldOverwriteOnConflict } from "../src/editor";

const writes = () =>
  invokeMock.mock.calls.filter((c) => c[0] === "write_file") as [string, { path: string; text: string; baseline: number }][];

describe("shouldOverwriteOnConflict (conflict policy rule)", () => {
  it("is true only for overwrite", () => {
    expect(shouldOverwriteOnConflict("pause")).toBe(false);
    expect(shouldOverwriteOnConflict("overwrite")).toBe(true);
  });
});

describe("autosaveDelay thread", () => {
  let host: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockClear();
    writeHandler = () => Promise.resolve(2); // success → new mtime
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => vi.useRealTimers());

  it("debounces the write at the threaded delay, not the old 500ms default", async () => {
    const ed = mountEditor(host, "hello", "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
      autosaveDelay: 1500,
    });
    ed.view.dispatch({ changes: { from: 5, insert: "!" } });
    await vi.advanceTimersByTimeAsync(1000); // past the old 500 default
    expect(writes().length).toBe(0); // not yet — delay is 1500
    await vi.advanceTimersByTimeAsync(600); // now past 1500 total
    expect(writes().length).toBe(1);
    expect(writes()[0][1].text).toBe("hello!");
    ed.view.destroy();
  });

  it("applies a live delay change from the NEXT debounce (in-flight timer keeps its delay)", async () => {
    const ed = mountEditor(host, "a", "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
      autosaveDelay: 500,
    });
    ed.setAutosaveDelay(2000); // change before any edit
    ed.view.dispatch({ changes: { from: 1, insert: "b" } });
    await vi.advanceTimersByTimeAsync(500); // old delay would have fired here
    expect(writes().length).toBe(0);
    await vi.advanceTimersByTimeAsync(1600);
    expect(writes().length).toBe(1);
    ed.view.destroy();
  });
});

describe("conflictPolicy branch", () => {
  let host: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => vi.useRealTimers());

  it("pause (default): a refused write halts autosave; no further writes, no overwrite", async () => {
    writeHandler = () => Promise.reject("CONFLICT: file changed on disk");
    const ed = mountEditor(host, "a", "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
      autosaveDelay: 100,
      conflictPolicy: "pause",
      baseMtime: 1, // non-zero so a normal write ≠ a baseline:0 overwrite
    });
    ed.view.dispatch({ changes: { from: 1, insert: "b" } });
    await vi.advanceTimersByTimeAsync(150); // fire the debounce → conflicting write
    expect(writes().length).toBe(1); // it ran once and was refused
    // a second edit must NOT schedule another write while conflicted
    ed.view.dispatch({ changes: { from: 2, insert: "c" } });
    await vi.advanceTimersByTimeAsync(150);
    expect(writes().length).toBe(1); // autosave paused — no clobber
    // no write used baseline:0 (no overwrite under pause)
    expect(writes().every((c) => c[1].baseline !== 0)).toBe(true);
    ed.view.destroy();
  });

  it("overwrite: a refused write re-records the buffer at baseline 0 (clobbers the external change)", async () => {
    let conflictOnce = true;
    writeHandler = (args) => {
      if (conflictOnce && args.baseline !== 0) {
        conflictOnce = false;
        return Promise.reject("CONFLICT: file changed on disk");
      }
      return Promise.resolve(3); // the baseline:0 retry succeeds
    };
    const ed = mountEditor(host, "a", "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
      autosaveDelay: 100,
      conflictPolicy: "overwrite",
      baseMtime: 1, // first write carries this baseline; the overwrite retry drops to 0
    });
    ed.view.dispatch({ changes: { from: 1, insert: "b" } });
    await vi.advanceTimersByTimeAsync(150);
    expect(writes().some((c) => c[1].baseline === 0)).toBe(true);
    const overwrite = writes().find((c) => c[1].baseline === 0)!;
    expect(overwrite[1].text).toBe("ab"); // the user's buffer, not the external change
    ed.view.destroy();
  });
});

describe("forceSave absorbs the pending debounce", () => {
  let host: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockClear();
    writeHandler = () => Promise.resolve(2);
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => vi.useRealTimers());

  it("clears the scheduled debounce so no duplicate write fires after a force-save", async () => {
    const ed = mountEditor(host, "a", "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
      autosaveDelay: 500,
    });
    ed.view.dispatch({ changes: { from: 1, insert: "b" } }); // schedules a 500ms debounce
    ed.forceSave(); // overwrite now — must cancel the pending timer
    await vi.advanceTimersByTimeAsync(0); // settle the force-save promise
    expect(writes().length).toBe(1); // only the force-save
    expect(writes()[0][1].baseline).toBe(0); // force-save writes at baseline 0
    await vi.advanceTimersByTimeAsync(1000); // the old debounce window must NOT fire a 2nd write
    expect(writes().length).toBe(1);
    ed.view.destroy();
  });
});
