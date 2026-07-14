import { describe, it, expect, beforeEach } from "vitest";

// R11 (_workspace/01_r11.md §9 RED-1): the non-markdown-file viewer registry.
// vitest gives each test file a fresh module graph, so `viewers` (registry.ts's
// module-level array) resets between files automatically — no unregister
// needed for isolation (design §2's stated reason for skipping unregister).
// Within THIS file, tests share the module singleton, so each `it` registers
// distinct ids/extensions to avoid cross-test collisions.

const handle = () => ({ close: () => {} });

describe("viewer registry (R11)", () => {
  it("duplicate id registration throws", async () => {
    const { registerViewer } = await import("../src/chrome/viewer/registry");
    registerViewer({ id: "dup-a", extensions: ["dup1"], open: handle });
    expect(() => registerViewer({ id: "dup-a", extensions: ["dup2"], open: handle })).toThrow(
      /already registered/,
    );
  });

  it.each(["XLSX", ".xlsx", ""])("rejects a malformed extension %j", async (ext) => {
    const { registerViewer } = await import("../src/chrome/viewer/registry");
    expect(() => registerViewer({ id: `bad-${ext || "empty"}`, extensions: [ext], open: handle })).toThrow();
  });

  it("viewerFor: unregistered extension is null; registered extension resolves to its viewer", async () => {
    const { registerViewer, viewerFor } = await import("../src/chrome/viewer/registry");
    expect(viewerFor("nope")).toBeNull();
    const v = { id: "single", extensions: ["single-ext"], open: handle };
    registerViewer(v);
    expect(viewerFor("single-ext")).toBe(v);
  });

  it("two viewers claiming the same extension: first-registered wins (first-claim-wins)", async () => {
    const { registerViewer, viewerFor } = await import("../src/chrome/viewer/registry");
    const first = { id: "claim-first", extensions: ["shared"], open: handle };
    const second = { id: "claim-second", extensions: ["shared"], open: handle };
    registerViewer(first);
    registerViewer(second);
    expect(viewerFor("shared")).toBe(first);
  });
});
