import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Controllable invoke: read_file → {text,mtime}; write_file routes through a
// per-test handler so a CONFLICT can be simulated; everything else → false.
let writeHandler: (args: { path: string; text: string; baseline: number }) => Promise<number>;
let readHandler: () => Promise<{ text: string; mtime: number }>;
const invokeMock = vi.fn((cmd: string, args?: unknown) => {
  if (cmd === "read_file") return readHandler();
  if (cmd === "write_file")
    return writeHandler(args as { path: string; text: string; baseline: number });
  return Promise.resolve(false);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

import { mountEditor, shouldOverwriteOnConflict } from "../src/editor";
import { createRecoveryState } from "../src/document/recovery-contract";

const writes = () =>
  invokeMock.mock.calls.filter((c) => c[0] === "write_file") as [string, { path: string; text: string; baseline: number }][];

describe("shouldOverwriteOnConflict (conflict policy rule)", () => {
  it("is true only for overwrite", () => {
    expect(shouldOverwriteOnConflict("pause")).toBe(false);
    expect(shouldOverwriteOnConflict("overwrite")).toBe(true);
  });
});

describe("filesystem recovery contract for save failures", () => {
  it("keeps the buffer and tab while offering non-overwriting save recovery", () => {
    const state = createRecoveryState("save", "disk full");

    expect(state.preservation).toBe("keep-buffer-and-tab");
    expect(state.allowedActions.map((action) => action.id)).toEqual([
      "retry",
      "save-recovered-copy",
      "save-as",
      "close-discard",
    ]);
    expect(state.allowedActions.find((action) => action.id === "close-discard")?.requiresConfirmation).toBe(true);
  });
});

describe("autosaveDelay thread", () => {
  let host: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockClear();
    readHandler = () => Promise.resolve({ text: "", mtime: 1 });
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
    readHandler = () => Promise.resolve({ text: "", mtime: 1 });
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

  it("overwrite policy still pauses a refused write until an explicit force-save", async () => {
    writeHandler = () => Promise.reject("CONFLICT: file changed on disk");
    const ed = mountEditor(host, "a", "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
      autosaveDelay: 100,
      conflictPolicy: "overwrite",
      baseMtime: 1, // first write carries this baseline; the overwrite retry drops to 0
    });
    ed.view.dispatch({ changes: { from: 1, insert: "b" } });
    await vi.advanceTimersByTimeAsync(150);
    expect(writes()).toHaveLength(1);
    expect(writes().every((c) => c[1].baseline !== 0)).toBe(true);
    ed.view.destroy();
  });
});

describe("reloadFromFile branch", () => {
  let host: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockClear();
    readHandler = () => Promise.resolve({ text: "", mtime: 1 });
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => vi.useRealTimers());

  it("resets conflicted state, updates editor text, sets new baseline, and clears pending", async () => {
    let status: string = "";
    writeHandler = () => Promise.reject("CONFLICT: file changed on disk");
    const ed = mountEditor(host, "a", "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
      autosaveDelay: 100,
      conflictPolicy: "pause",
      baseMtime: 1,
      onStatus: (s) => {
        status = s;
      },
    });

    ed.view.dispatch({ changes: { from: 1, insert: "b" } });
    await vi.advanceTimersByTimeAsync(150); // fire the debounce -> CONFLICT
    expect(status).toBe("conflict");

    // Reload from disk
    ed.reloadFromFile("external content", 42);
    expect(ed.view.state.doc.toString()).toBe("external content");
    expect(status).toBe("saved");

    // Make a new edit and ensure it autosaves successfully using the new baseline
    let receivedBaseline: number | null = null;
    writeHandler = (args) => {
      receivedBaseline = args.baseline;
      return Promise.resolve(43);
    };
    ed.view.dispatch({ changes: { from: ed.view.state.doc.length, insert: "!" } });
    await vi.advanceTimersByTimeAsync(150);
    expect(writes().length).toBe(2); // first conflict write + this new write
    expect(receivedBaseline).toBe(42);
    expect(status).toBe("saved");

    ed.view.destroy();
  });
});

describe("forceSave absorbs the pending debounce", () => {
  let host: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockClear();
    readHandler = () => Promise.resolve({ text: "", mtime: 1 });
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

describe("safe recovery suspension", () => {
  let host: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockClear();
    readHandler = () => Promise.resolve({ text: "", mtime: 1 });
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => vi.useRealTimers());

  it("suspends the original path after it becomes unreadable before autosave can retry", async () => {
    const statuses: string[] = [];
    writeHandler = () => Promise.reject("write /tmp/doc.md: No such file or directory");
    const ed = mountEditor(host, "keep me", "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
      autosaveDelay: 50,
      onStatus: (status) => statuses.push(status),
    });

    ed.view.dispatch({ changes: { from: 7, insert: "!" } });
    await vi.advanceTimersByTimeAsync(60);
    expect(statuses).toContain("recovery");
    expect(ed.hasUnsaved()).toBe(true);

    ed.view.dispatch({ changes: { from: 8, insert: "?" } });
    await vi.advanceTimersByTimeAsync(500);
    expect(writes()).toHaveLength(1);
    ed.view.destroy();
  });

  it("never writes the original path for recovery-copy or cancelled retry", async () => {
    writeHandler = (args) => args.path.endsWith(".mermark-recovered") ? Promise.resolve(4) : Promise.reject("ENOENT");
    readHandler = () => Promise.reject("ENOENT");
    const ed = mountEditor(host, "buffer", "/tmp", "/tmp/doc.md", { initialMode: "edit", autosaveDelay: 10 });
    ed.suspendWrites("deleted");

    await ed.saveRecoveredCopy();
    expect(writes().every(([, args]) => args.path !== "/tmp/doc.md")).toBe(true);
    expect(await ed.retryOriginal()).toBe(false);
    expect(writes().every(([, args]) => args.path !== "/tmp/doc.md")).toBe(true);
    ed.view.destroy();
  });

  it("proves a deleted dirty file is never recreated during recovery", async () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "mermark-recovery-"));
    const original = join(root, "note.md");
    const recovered = `${original}.mermark-recovered`;
    writeFileSync(original, "on disk");
    readHandler = async () => ({ text: readFileSync(original, "utf8"), mtime: 1 });
    writeHandler = async (args) => {
      if (!existsSync(args.path) && args.path === original) throw new Error("ENOENT");
      writeFileSync(args.path, args.text);
      return 2;
    };
    try {
      const ed = mountEditor(document.createElement("div"), "dirty buffer", root, original, { initialMode: "edit" });
      ed.suspendWrites("deleted");
      unlinkSync(original);

      expect(await ed.saveRecoveredCopy()).toBe(true);
      expect(existsSync(original)).toBe(false);
      expect(readFileSync(recovered, "utf8")).toBe("dirty buffer");
      expect(await ed.retryOriginal()).toBe(false);
      expect(existsSync(original)).toBe(false);
      ed.view.destroy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
