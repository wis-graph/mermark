import { describe, it, expect, vi, beforeEach } from "vitest";
import { wikilinkPath, isImageTarget, WikilinkWidget } from "../src/markdown/wikilink";

const mockInvoke = vi.fn();
const mockOpenAsset = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: (...args: any[]) => mockOpenAsset(...args),
}));

describe("wikilinkPath", () => {
  const baseDir = "/home/u/notes";
  it("appends .md when no extension", () => {
    expect(wikilinkPath("foo", baseDir)).toBe("/home/u/notes/foo.md");
  });
  it("keeps an explicit extension", () => {
    expect(wikilinkPath("foo.md", baseDir)).toBe("/home/u/notes/foo.md");
  });
  it("resolves nested targets", () => {
    expect(wikilinkPath("sub/bar", baseDir)).toBe("/home/u/notes/sub/bar.md");
  });
  it("strips #heading anchors before resolving (D6)", () => {
    expect(wikilinkPath("note#section", baseDir)).toBe("/home/u/notes/note.md");
  });
  it("strips #^block refs before resolving (D6)", () => {
    expect(wikilinkPath("note#^abc123", baseDir)).toBe("/home/u/notes/note.md");
  });
  it("resolves bare [[#heading]] to the current file", () => {
    expect(wikilinkPath("#section", baseDir, "/home/u/notes/self.md")).toBe("/home/u/notes/self.md");
  });
});

describe("isImageTarget", () => {
  it("recognizes image extensions", () => {
    expect(isImageTarget("pic.png")).toBe(true);
    expect(isImageTarget("photo.JPEG")).toBe(true);
    expect(isImageTarget("note")).toBe(false);
    expect(isImageTarget("doc.md")).toBe(false);
  });
});

describe("WikilinkWidget toDOM click behaviors", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockOpenAsset.mockReset();
  });

  it("resolves bare same-file link immediately with no path_exists call", () => {
    const widget = new WikilinkWidget("alias", "");
    const dom = widget.toDOM({} as any);
    expect(dom.className).toContain("cm-wikilink-active");
    expect(dom.className).not.toContain("cm-wikilink-pending");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("checks existence and sets active class if existing markdown file", async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(true);
      return Promise.resolve();
    });

    const widget = new WikilinkWidget("alias", "existing.md");
    const dom = widget.toDOM({} as any);

    // wait for promise microtasks
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockInvoke).toHaveBeenCalledWith("path_exists", { path: "existing.md" });
    expect(dom.className).toContain("cm-wikilink-active");
    expect(dom.className).not.toContain("cm-wikilink-missing");

    dom.click();
    expect(mockInvoke).toHaveBeenCalledWith("open_path", { path: "existing.md" });
  });

  it("checks existence and opens non-markdown asset via openAsset if existing", async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(true);
      return Promise.resolve();
    });
    mockOpenAsset.mockResolvedValue(undefined);

    const widget = new WikilinkWidget("alias", "existing.pdf");
    const dom = widget.toDOM({} as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dom.className).toContain("cm-wikilink-active");

    dom.click();
    expect(mockOpenAsset).toHaveBeenCalledWith("existing.pdf");
    expect(mockInvoke).not.toHaveBeenCalledWith("open_path", expect.any(Object));
  });

  it("auto-creates and opens when missing markdown file is clicked", async () => {
    let exists = false;
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(exists);
      if (cmd === "create_markdown_file") {
        exists = true;
        return Promise.resolve();
      }
      if (cmd === "open_path") return Promise.resolve();
      return Promise.resolve();
    });

    const widget = new WikilinkWidget("alias", "missing.md");
    const dom = widget.toDOM({} as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dom.className).toContain("cm-wikilink-missing");

    // Simulate clicking the missing file link
    dom.click();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockInvoke).toHaveBeenCalledWith("create_markdown_file", { path: "missing.md" });
    expect(mockInvoke).toHaveBeenCalledWith("open_path", { path: "missing.md" });
    expect(dom.className).toContain("cm-wikilink-active");
    expect(dom.className).not.toContain("cm-wikilink-missing");
  });

  it("shows error and does not auto-create if missing asset is clicked", async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(false);
      return Promise.resolve();
    });

    const widget = new WikilinkWidget("alias", "missing.pdf");
    const dom = widget.toDOM({} as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dom.className).toContain("cm-wikilink-missing");

    dom.click();

    expect(mockInvoke).not.toHaveBeenCalledWith("create_markdown_file", expect.any(Object));
    expect(dom.className).toContain("cm-wikilink-error");
    expect(dom.title).toContain("마크다운 파일만 자동 생성 가능");
  });
});
