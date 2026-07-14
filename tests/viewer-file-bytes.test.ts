import { describe, it, expect, vi, afterEach } from "vitest";

// R11 (_workspace/01_r11.md §1): readLocalFileBytes is the single owner of the
// fetch(convertFileSrc(abs)) rule. team-lead's explicit requirement: a failed
// read must THROW, never resolve silently — the Excel viewer's open() relies
// on this to surface "문서를 열 수 없습니다: ..." instead of leaving the user
// staring at a stuck "불러오는 중…" with no explanation (this session's
// "quiet failure is forbidden" mandate).
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readLocalFileBytes (R11 §1)", () => {
  it("resolves with the response bytes on a 2xx response", async () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", arrayBuffer: async () => buf }),
    );
    const { readLocalFileBytes } = await import("../src/chrome/viewer/file-bytes");
    await expect(readLocalFileBytes("/tmp/x.xlsx")).resolves.toBe(buf);
  });

  it("THROWS (never resolves silently) on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found", arrayBuffer: async () => new ArrayBuffer(0) }),
    );
    const { readLocalFileBytes } = await import("../src/chrome/viewer/file-bytes");
    await expect(readLocalFileBytes("/tmp/missing.xlsx")).rejects.toThrow(/404/);
  });

  it("propagates a network-level fetch rejection (no swallowing)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { readLocalFileBytes } = await import("../src/chrome/viewer/file-bytes");
    await expect(readLocalFileBytes("/tmp/x.xlsx")).rejects.toThrow(/Failed to fetch/);
  });
});
