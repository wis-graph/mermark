import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeSpy = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
  invoke: (...args: unknown[]) => invokeSpy(...args),
}));

import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { VideoWidget } from "../src/markdown/embed";
import { clearRemoteVideoCache } from "../src/markdown/remote-video";
import { REMOTE_ASSET_TOO_LARGE_MESSAGE } from "../src/chrome/viewer/file-bytes";
import { documentVault } from "../src/document/document-vault";
import type { RemoteVault } from "../src/workspace/workspace-state";

const remoteVault: RemoteVault = {
  vaultId: "v-r", workspaceId: "w", displayName: "r", rootPath: null, persistenceKind: "remote",
  explorerRoot: "remote://h/", host: "h", remoteVaultId: "rv",
};
const remoteView = { state: EditorState.create({ extensions: [documentVault.of(remoteVault)] }) } as unknown as EditorView;
const localView = { state: EditorState.create({}) } as unknown as EditorView;

const flush = () => new Promise((r) => setTimeout(r, 0));
let revoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeSpy.mockReset();
  clearRemoteVideoCache();
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:mock/1");
  revoke = vi.fn();
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revoke;
});

describe("VideoWidget local DOM is byte-for-byte unchanged", () => {
  it("renders the plain <video> for a local document", () => {
    const w = new VideoWidget("asset://localhost//base/clip.mp4", "alt", "clip.mp4", "/base");
    expect(w.toDOM(localView).outerHTML).toBe(
      '<video class="cm-video" controls="" src="asset://localhost//base/clip.mp4" title="alt"></video>',
    );
  });
  it("omits title when alt is empty", () => {
    const w = new VideoWidget("asset://localhost//base/clip.mp4", "", "clip.mp4", "/base");
    expect(w.toDOM(localView).outerHTML).toBe('<video class="cm-video" controls="" src="asset://localhost//base/clip.mp4"></video>');
  });
});

describe("VideoWidget in a remote vault", () => {
  const mk = (raw: string, base = "") => new VideoWidget(`asset://localhost/${raw}`, "alt", raw, base);

  it("renders a click-to-load facade and fetches nothing before the click", () => {
    const dom = mk("clip.mp4").toDOM(remoteView);
    expect(dom.classList.contains("cm-video-remote")).toBe(true);
    expect(dom.querySelector("video")).toBeNull();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["clip.mp4", "", "clip.mp4"],
    ["clip.mp4", "notes", "notes/clip.mp4"],
    ["clip.mp4#t=10", "notes", "notes/clip.mp4"],
  ])("click loads %s (base %j) from path %s and swaps in a blob <video>", async (raw, base, path) => {
    invokeSpy.mockResolvedValue(new Uint8Array(4).buffer);
    const dom = mk(raw, base).toDOM(remoteView);
    document.body.appendChild(dom);
    (dom.querySelector(".cm-video-remote-load") as HTMLButtonElement).click();
    await flush();
    expect(invokeSpy).toHaveBeenCalledWith("remote_read_asset", { host: "h", vault: "rv", path });
    const video = dom.querySelector("video.cm-video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe(raw.includes("#") ? "blob:mock/1#t=10" : "blob:mock/1");
    expect(video.controls).toBe(true);
  });

  it("too-large shows the size message, no video, no button", async () => {
    invokeSpy.mockRejectedValue("REMOTE_ASSET_TOO_LARGE: clip.mp4");
    const dom = mk("clip.mp4").toDOM(remoteView);
    (dom.querySelector(".cm-video-remote-load") as HTMLButtonElement).click();
    await flush();
    const cap = dom.querySelector(".cm-video-remote-caption") as HTMLElement;
    expect(cap.classList.contains("is-error")).toBe(true);
    expect(cap.textContent).toBe(REMOTE_ASSET_TOO_LARGE_MESSAGE);
    expect(dom.querySelector("video")).toBeNull();
    expect((dom.querySelector(".cm-video-remote-load") as HTMLButtonElement).hidden).toBe(true);
  });

  it("an https target in a remote vault passes through as a plain <video> (no facade)", () => {
    const w = new VideoWidget("https://ex.com/clip.mp4", "alt", "https://ex.com/clip.mp4", "");
    const dom = w.toDOM(remoteView);
    expect(dom.outerHTML).toBe('<video class="cm-video" controls="" src="https://ex.com/clip.mp4" title="alt"></video>');
  });

  it("destroy revokes the object URL of a loaded DOM only", async () => {
    invokeSpy.mockResolvedValue(new Uint8Array(1).buffer);
    const w = mk("clip.mp4");
    const loaded = w.toDOM(remoteView);
    document.body.appendChild(loaded);
    const idle = w.toDOM(remoteView);
    (loaded.querySelector(".cm-video-remote-load") as HTMLButtonElement).click();
    await flush();
    w.destroy(idle);
    expect(revoke).not.toHaveBeenCalled();
    w.destroy(loaded);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:mock/1");
    const local = new VideoWidget("asset://x/a.mp4", "", "a.mp4", "/b");
    local.destroy(local.toDOM(localView));
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("a load arriving after the box left the document mints no object URL", async () => {
    invokeSpy.mockResolvedValue(new Uint8Array(1).buffer);
    const createSpy = URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
    const dom = mk("clip.mp4").toDOM(remoteView);
    document.body.appendChild(dom);
    (dom.querySelector(".cm-video-remote-load") as HTMLButtonElement).click();
    dom.remove(); // teardown that never calls WidgetType.destroy (replaceChildren)
    await flush();
    expect(createSpy).not.toHaveBeenCalled();
    expect(dom.querySelector("video")).toBeNull();
  });

  it("a load arriving while the box is still connected mints the URL", async () => {
    invokeSpy.mockResolvedValue(new Uint8Array(1).buffer);
    const dom = mk("clip.mp4").toDOM(remoteView);
    document.body.appendChild(dom);
    (dom.querySelector(".cm-video-remote-load") as HTMLButtonElement).click();
    await flush();
    expect(dom.querySelector("video")).not.toBeNull();
    dom.remove();
  });

  it("eq compares url, rawSrc, baseDir; alt is cosmetic", () => {
    const a = new VideoWidget("u", "a", "r", "b");
    expect(a.eq(new VideoWidget("u", "other", "r", "b"))).toBe(true);
    expect(a.eq(new VideoWidget("u", "a", "r2", "b"))).toBe(false);
    expect(a.eq(new VideoWidget("u", "a", "r", "b2"))).toBe(false);
  });
});
