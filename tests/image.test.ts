import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the Tauri core: convertFileSrc echoes its input (so an asset URL equals
// its path, making the src swap observable), invoke is a spy we assert against.
const invokeSpy = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: (...args: unknown[]) => invokeSpy(...args),
}));

import { resolveImageSrc, ImageWidget } from "../src/markdown/image";
import { recursiveImageSearchSetting } from "../src/settings/app";

describe("resolveImageSrc", () => {
  const baseDir = "/home/u/notes";
  it("leaves absolute http(s) urls untouched", () => {
    expect(resolveImageSrc("https://x.com/a.png", baseDir)).toBe("https://x.com/a.png");
  });
  it("joins a relative path onto the base dir", () => {
    expect(resolveImageSrc("img/a.png", baseDir)).toBe("/home/u/notes/img/a.png");
  });
  it("keeps an absolute filesystem path as-is", () => {
    expect(resolveImageSrc("/abs/a.png", baseDir)).toBe("/abs/a.png");
  });
});

describe("ImageWidget recursive-search fallback", () => {
  const baseDir = "/home/u/notes";

  beforeEach(() => {
    invokeSpy.mockReset();
    recursiveImageSearchSetting.set("on");
  });

  // Mount the widget DOM and fire its onerror as the browser would on a failed
  // literal load.
  const mountImg = (rawSrc: string, literalUrl = `${baseDir}/${rawSrc}`) => {
    const w = new ImageWidget(literalUrl, "alt", rawSrc, baseDir);
    const img = w.toDOM() as HTMLImageElement;
    return img;
  };
  const fireError = (img: HTMLImageElement) => img.onerror?.(new Event("error"));
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("literal-first: a successful literal load never invokes resolve_image", () => {
    mountImg("pic.png"); // no onerror fired = the literal path loaded
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("on load failure, calls resolve_image with {baseDir,name,maxDepth:3} and swaps src", async () => {
    invokeSpy.mockResolvedValue("/mock/found/pic.png");
    const img = mountImg("pic.png");
    fireError(img);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy).toHaveBeenCalledWith("resolve_image", {
      baseDir,
      name: "pic.png",
      maxDepth: 3,
    });
    await flush();
    expect(img.src).toContain("/mock/found/pic.png");
  });

  it("when resolve_image returns null, the broken image is left as-is", async () => {
    invokeSpy.mockResolvedValue(null);
    const img = mountImg("missing.png");
    fireError(img);
    await flush();
    expect(img.src).toContain(`${baseDir}/missing.png`); // unchanged literal
  });

  it("infinite-fallback guard: a second onerror does not re-invoke", () => {
    invokeSpy.mockResolvedValue("/mock/found/pic.png");
    const img = mountImg("pic.png");
    fireError(img);
    fireError(img); // resolved src also fails → must not re-resolve
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it("setting off: onerror does not invoke resolve_image", () => {
    recursiveImageSearchSetting.set("off");
    const img = mountImg("pic.png");
    fireError(img);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("remote src: onerror does not invoke resolve_image", () => {
    const img = mountImg("https://x.com/a.png", "https://x.com/a.png");
    fireError(img);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("data: src: onerror does not invoke resolve_image", () => {
    const img = mountImg("data:image/png;base64,AAAA", "data:image/png;base64,AAAA");
    fireError(img);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("eq() includes rawSrc/baseDir so a stale-base rebuild is not reused", () => {
    const a = new ImageWidget("u", "alt", "pic.png", "/a");
    expect(a.eq(new ImageWidget("u", "alt", "pic.png", "/a"))).toBe(true);
    expect(a.eq(new ImageWidget("u", "alt", "pic.png", "/b"))).toBe(false);
    expect(a.eq(new ImageWidget("u", "alt", "other.png", "/a"))).toBe(false);
  });
});
