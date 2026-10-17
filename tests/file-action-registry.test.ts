import { describe, it, expect, vi } from "vitest";

// Per-file module graph isolation (same as viewer-registry.test.ts): each `it`
// registers distinct ids/extensions.

const noop = () => {};

describe("file action registry", () => {
  it("duplicate id throws", async () => {
    const { registerFileAction } = await import("../src/chrome/file-actions/registry");
    registerFileAction({ id: "dup", label: "A", extensions: ["dupx"], run: noop });
    expect(() => registerFileAction({ id: "dup", label: "B", extensions: ["dupy"], run: noop })).toThrow(/already registered/);
  });

  it.each(["PNG", ".png", ""])("rejects a malformed extension %j", async (ext) => {
    const { registerFileAction } = await import("../src/chrome/file-actions/registry");
    expect(() => registerFileAction({ id: `bad-${ext || "empty"}`, label: "x", extensions: [ext], run: noop })).toThrow();
  });

  it("rejects empty extensions", async () => {
    const { registerFileAction } = await import("../src/chrome/file-actions/registry");
    expect(() => registerFileAction({ id: "none", label: "x", extensions: [], run: noop })).toThrow();
  });

  it("fileActionsFor: unregistered ext is []", async () => {
    const { fileActionsFor } = await import("../src/chrome/file-actions/registry");
    expect(fileActionsFor("zz1")).toEqual([]);
  });

  it("two actions on one extension are BOTH returned in registration order (not first-claim-wins)", async () => {
    const { registerFileAction, fileActionsFor } = await import("../src/chrome/file-actions/registry");
    const a = { id: "both-a", label: "A", extensions: ["both"], run: noop };
    const b = { id: "both-b", label: "B", extensions: ["both", "other"], run: noop };
    registerFileAction(a);
    registerFileAction(b);
    expect(fileActionsFor("both")).toEqual([a, b]);
    expect(fileActionsFor("other")).toEqual([b]);
  });

  it("runFileAction passes absPath and swallows a sync throw into console.error", async () => {
    const { runFileAction } = await import("../src/chrome/file-actions/registry");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = vi.fn();
    runFileAction({ id: "r1", label: "x", extensions: ["r1"], run: ok }, "/a/b.r1");
    expect(ok).toHaveBeenCalledWith("/a/b.r1");
    expect(() =>
      runFileAction({ id: "r2", label: "x", extensions: ["r2"], run: () => { throw new Error("boom"); } }, "/a.r2"),
    ).not.toThrow();
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("runFileAction swallows an async reject into console.error", async () => {
    const { runFileAction } = await import("../src/chrome/file-actions/registry");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    runFileAction({ id: "r3", label: "x", extensions: ["r3"], run: () => Promise.reject(new Error("nope")) }, "/a.r3");
    await Promise.resolve();
    await Promise.resolve();
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
