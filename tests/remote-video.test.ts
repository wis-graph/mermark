import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeSpy = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: (...args: unknown[]) => invokeSpy(...args),
}));

import { loadRemoteVideo, clearRemoteVideoCache } from "../src/markdown/remote-video";
import { REMOTE_ASSET_TOO_LARGE_MESSAGE } from "../src/chrome/viewer/file-bytes";

const vault = { host: "h", remoteVaultId: "rv" };
const bytes = (n: number) => new Uint8Array(n).buffer;

beforeEach(() => {
  invokeSpy.mockReset();
  clearRemoteVideoCache();
});

describe("loadRemoteVideo", () => {
  it("fetches via remote_read_asset and returns a Blob typed by extension", async () => {
    invokeSpy.mockResolvedValue(bytes(7));
    const blob = await loadRemoteVideo(vault, "notes/clip.mp4");
    expect(invokeSpy).toHaveBeenCalledWith("remote_read_asset", { host: "h", vault: "rv", path: "notes/clip.mp4" });
    expect(blob.type).toBe("video/mp4");
    expect(blob.size).toBe(7);
  });

  it("caches by (host, vault, path): second call does not invoke again", async () => {
    invokeSpy.mockResolvedValue(bytes(3));
    await loadRemoteVideo(vault, "a.mp4");
    await loadRemoteVideo(vault, "a.mp4");
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it("a rejection is evicted so the next call retries", async () => {
    invokeSpy.mockRejectedValueOnce("SSH_TUNNEL_DOWN");
    await expect(loadRemoteVideo(vault, "a.mp4")).rejects.toBeTruthy();
    invokeSpy.mockResolvedValue(bytes(3));
    await loadRemoteVideo(vault, "a.mp4");
    expect(invokeSpy).toHaveBeenCalledTimes(2);
  });

  it("the 20 MiB refusal surfaces as REMOTE_ASSET_TOO_LARGE_MESSAGE", async () => {
    invokeSpy.mockRejectedValue("REMOTE_ASSET_TOO_LARGE: big.mp4");
    await expect(loadRemoteVideo(vault, "big.mp4")).rejects.toMatchObject({ message: REMOTE_ASSET_TOO_LARGE_MESSAGE });
  });

  it("is bounded (3 entries): the oldest key is evicted", async () => {
    invokeSpy.mockImplementation(() => Promise.resolve(bytes(1)));
    for (const n of ["1", "2", "3", "4"]) await loadRemoteVideo(vault, `${n}.mp4`);
    expect(invokeSpy).toHaveBeenCalledTimes(4);
    await loadRemoteVideo(vault, "1.mp4");
    expect(invokeSpy).toHaveBeenCalledTimes(5);
  });
});
