import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the Tauri core: convertFileSrc echoes its input (so an asset URL equals
// its path, making the src swap observable), invoke is a spy we assert against.
const invokeSpy = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: (...args: unknown[]) => invokeSpy(...args),
}));

import { resolveImageSrc, resolveImageUrl, ImageWidget, viewerSourceFor, isRemoteSrc } from "../src/markdown/image";
import { recursiveImageSearchSetting } from "../src/settings/app";
import { setImageOpenHandler } from "../src/markdown/image-open";
import type { EditorView } from "@codemirror/view";

// The click handler's `attachAltClickEdit` only ever touches `view` when a
// MOUSEDOWN carries Alt (not exercised by these click-only tests), so a stub
// that satisfies the type without a real editor is enough here — mounting a
// full EditorView per test would test nothing this file doesn't already
// cover elsewhere (wikilink*.test.ts owns the real Alt+click-edit assertion).
const fakeView = {} as unknown as EditorView;

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

describe("isRemoteSrc", () => {
  it("true for http(s) and data: URLs, false for local paths", () => {
    expect(isRemoteSrc("https://x.com/a.png")).toBe(true);
    expect(isRemoteSrc("http://x.com/a.png")).toBe(true);
    expect(isRemoteSrc("data:image/png;base64,AAAA")).toBe(true);
    expect(isRemoteSrc("img/a.png")).toBe(false);
    expect(isRemoteSrc("/abs/a.png")).toBe(false);
  });
});

// Regression (04_audit_report_imgclick.md 🟡②): resolveImageSrc/resolveImageUrl
// used to each inline their own remote-URL test (one of them a DRIFTED
// variant, `/^https?:|^data:/i` — no `//` required). Both now delegate to
// isRemoteSrc; these pin the pre-existing behavior for every well-formed
// input so the unification is provably not a behavior change.
describe("resolveImageSrc/resolveImageUrl (unified on isRemoteSrc — no behavior change)", () => {
  it("resolveImageSrc still passes http(s)/data URLs through untouched", () => {
    expect(resolveImageSrc("http://x.com/a.png", "/docs")).toBe("http://x.com/a.png");
    expect(resolveImageSrc("data:image/png;base64,AAAA", "/docs")).toBe("data:image/png;base64,AAAA");
  });
  it("resolveImageUrl still passes http(s)/data URLs through untouched (no convertFileSrc)", () => {
    expect(resolveImageUrl("https://x.com/a.png", "/docs")).toBe("https://x.com/a.png");
    expect(resolveImageUrl("data:image/png;base64,AAAA", "/docs")).toBe("data:image/png;base64,AAAA");
  });
  it("resolveImageUrl still converts a local path via convertFileSrc", () => {
    expect(resolveImageUrl("a.png", "/docs")).toBe("/docs/a.png"); // convertFileSrc mock echoes input
  });
});

describe("viewerSourceFor", () => {
  const baseDir = "/docs";
  it("resolves a local relative rawSrc against baseDir", () => {
    expect(viewerSourceFor("cat.png", baseDir, null)).toBe("/docs/cat.png");
  });
  it("passes a remote URL through untouched", () => {
    expect(viewerSourceFor("https://ex.com/c.png", baseDir, null)).toBe("https://ex.com/c.png");
  });
  it("prefers the recursive-search resolvedPath over the literal rawSrc", () => {
    expect(viewerSourceFor("cat.png", baseDir, "/docs/img/cat.png")).toBe("/docs/img/cat.png");
  });
  it("null for an empty rawSrc (legacy no-arg constructor default)", () => {
    expect(viewerSourceFor("", baseDir, null)).toBeNull();
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
    const img = w.toDOM(fakeView) as HTMLImageElement;
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

describe("ImageWidget click → open viewer (_workspace/01_architect_design_imgclick.md)", () => {
  const baseDir = "/home/u/notes";
  let openSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openSpy = vi.fn();
    setImageOpenHandler(openSpy);
  });

  const mountImg = (rawSrc: string) => {
    const w = new ImageWidget(`${baseDir}/${rawSrc}`, "alt", rawSrc, baseDir);
    return w.toDOM(fakeView) as HTMLImageElement;
  };

  const clickAt = (img: HTMLImageElement, x: number, y: number, opts: Partial<MouseEventInit> = {}) => {
    img.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: y, bubbles: true }));
    img.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true, ...opts }));
  };

  it("a plain click requests the viewer to open with the resolved local source", () => {
    const img = mountImg("cat.png");
    clickAt(img, 10, 10);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(`${baseDir}/cat.png`);
  });

  it("a remote rawSrc is handed to the viewer untouched (no baseDir join)", () => {
    const img = mountImg("https://ex.com/c.png");
    clickAt(img, 10, 10);
    expect(openSpy).toHaveBeenCalledWith("https://ex.com/c.png");
  });

  it("Alt+click does not open the viewer (falls through to source-edit instead)", () => {
    const img = mountImg("cat.png");
    clickAt(img, 10, 10, { altKey: true });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("a click whose pointer moved past the drag slop (>4px) is treated as a drag release, not a click", () => {
    const img = mountImg("cat.png");
    img.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0, bubbles: true }));
    img.dispatchEvent(new MouseEvent("click", { clientX: 10, clientY: 0, bubbles: true }));
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("a click within the drag slop (≤4px) still opens the viewer", () => {
    const img = mountImg("cat.png");
    img.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0, bubbles: true }));
    img.dispatchEvent(new MouseEvent("click", { clientX: 3, clientY: 0, bubbles: true }));
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("after the recursive-search fallback resolves, a click opens the RESOLVED file, not the failed literal", async () => {
    invokeSpy.mockReset();
    invokeSpy.mockResolvedValue("/mock/found/pic.png");
    recursiveImageSearchSetting.set("on");
    const img = mountImg("pic.png");
    img.onerror?.(new Event("error"));
    await new Promise((r) => setTimeout(r, 0));
    clickAt(img, 10, 10);
    expect(openSpy).toHaveBeenCalledWith("/mock/found/pic.png");
  });
});
