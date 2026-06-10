import { describe, it, expect } from "vitest";
import { wikilinkPath, isImageTarget } from "../src/markdown/wikilink";

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
