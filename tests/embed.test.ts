import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://localhost/${p}` }));
import { youtubeId, isVideoTarget, videoMimeFor, embedWidgetFor, YoutubeFacadeWidget, VideoWidget } from "../src/markdown/embed";

describe("youtubeId", () => {
  it("extracts the id from a watch url", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("extracts from youtu.be, embed, shorts", () => {
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("ignores extra params and accepts m./no-www", () => {
    expect(youtubeId("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("returns null for non-youtube or malformed urls (→ fallback)", () => {
    expect(youtubeId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(youtubeId("https://youtu.be/short")).toBeNull(); // not 11 chars
    expect(youtubeId("image.png")).toBeNull();
  });
});

describe("isVideoTarget", () => {
  it("matches known video extensions, case-insensitive", () => {
    for (const ext of ["mp4", "webm", "ogg", "ogv", "mov", "m4v"]) {
      expect(isVideoTarget(`clip.${ext}`)).toBe(true);
      expect(isVideoTarget(`clip.${ext.toUpperCase()}`)).toBe(true);
    }
  });
  it("strips a #fragment before matching", () => {
    expect(isVideoTarget("clip.mp4#t=10")).toBe(true);
  });
  it("rejects images and other targets", () => {
    expect(isVideoTarget("image.png")).toBe(false);
    expect(isVideoTarget("note.md")).toBe(false);
  });
});

describe("embedWidgetFor (youtube → video → null priority)", () => {
  it("returns a YouTube facade for a youtube link", () => {
    const w = embedWidgetFor("https://youtu.be/dQw4w9WgXcQ", "alt", "/base");
    expect(w).toBeInstanceOf(YoutubeFacadeWidget);
  });
  it("returns a video widget for a video file", () => {
    // remote https passes through resolveImageUrl without convertFileSrc (no Tauri
    // internals in jsdom); the local-path → asset URL branch is covered manually.
    expect(embedWidgetFor("https://example.com/clip.mp4", "alt", "/base")).toBeInstanceOf(VideoWidget);
  });
  it("returns null for an image (caller falls back)", () => {
    expect(embedWidgetFor("image.png", "alt", "/base")).toBeNull();
  });
});

describe("videoMimeFor", () => {
  it("maps each video extension to its MIME (case-insensitive)", () => {
    const table: Record<string, string> = {
      mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm",
      ogg: "video/ogg", ogv: "video/ogg", mov: "video/quicktime",
    };
    for (const [ext, mime] of Object.entries(table)) {
      expect(videoMimeFor(`clip.${ext}`)).toBe(mime);
      expect(videoMimeFor(`clip.${ext.toUpperCase()}`)).toBe(mime);
    }
  });
  it("strips a #fragment; null for non-video targets", () => {
    expect(videoMimeFor("clip.mp4#t=10")).toBe("video/mp4");
    expect(videoMimeFor("a.png")).toBeNull();
  });
});

describe("embedWidgetFor video carries its raw target for remote loading", () => {
  it("VideoWidget keeps rawSrc and baseDir", () => {
    const w = embedWidgetFor("clip.mp4", "alt", "/base") as VideoWidget;
    expect(w).toBeInstanceOf(VideoWidget);
    expect(w.rawSrc).toBe("clip.mp4");
    expect(w.baseDir).toBe("/base");
  });
});

describe("video-mime leaf module", () => {
  it("is the source of embed's videoMimeFor and remote-video no longer imports embed", async () => {
    const leaf = await import("../src/markdown/video-mime");
    expect(leaf.videoMimeFor).toBe(videoMimeFor);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/markdown/remote-video.ts", "utf8")).not.toMatch(/from "\.\/embed"/);
  });
});
