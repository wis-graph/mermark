import { describe, it, expect } from "vitest";
import { dirOf, resolveOpenPath, isBlankPath, formatRootLabel } from "../src/path";

describe("dirOf", () => {
  it("returns the parent directory of an absolute posix path", () => {
    expect(dirOf("/Users/x/notes/foo.md")).toBe("/Users/x/notes");
  });
  it("returns the parent directory of a relative path", () => {
    expect(dirOf("notes/foo.md")).toBe("notes");
  });
  it("returns empty string for a bare filename (no separator) — must NOT eat the last char", () => {
    expect(dirOf("foo.md")).toBe(""); // regression: old slice(0,-1) gave "foo.m"
  });
  it("returns empty string for a root-level file", () => {
    expect(dirOf("/foo.md")).toBe("");
  });
  it("handles windows backslash separators", () => {
    expect(dirOf("C:\\Users\\x\\foo.md")).toBe("C:\\Users\\x");
  });
  it("handles empty input", () => {
    expect(dirOf("")).toBe("");
  });
});

describe("isBlankPath", () => {
  it("is true for empty and whitespace-only input", () => {
    expect(isBlankPath("")).toBe(true);
    expect(isBlankPath("   ")).toBe(true);
    expect(isBlankPath("\t\n")).toBe(true);
  });
  it("is false for any non-whitespace input", () => {
    expect(isBlankPath("a.md")).toBe(false);
    expect(isBlankPath("  x  ")).toBe(false);
  });
});

describe("formatRootLabel", () => {
  it("abbreviates a home directory to ~", () => {
    expect(formatRootLabel("/Users/wis/projects/mermark")).toContain("~");
    expect(formatRootLabel("/Users/wis/projects/mermark")).not.toContain("/Users/wis");
    expect(formatRootLabel("/home/wis")).toBe("~");
  });
  it("keeps the last N segments with a leading … for long paths", () => {
    const out = formatRootLabel("/a/b/c/d/e/f", 3);
    expect(out.endsWith("d/e/f")).toBe(true);
    expect(out.startsWith("…/")).toBe(true);
  });
  it("returns short paths intact (no …)", () => {
    expect(formatRootLabel("/a/b")).toBe("/a/b");
    expect(formatRootLabel("/a/b/c")).toBe("/a/b/c"); // exactly keepSegments
  });
  it("abbreviates a windows home directory to ~", () => {
    expect(formatRootLabel("C:\\Users\\wis")).toBe("~");
  });
});

describe("resolveOpenPath", () => {
  it("returns an absolute posix path unchanged", () => {
    expect(resolveOpenPath("/a/b.md", "/home/n")).toBe("/a/b.md");
  });
  it("joins a relative path against baseDir (no normalization — backend does that)", () => {
    expect(resolveOpenPath("child.md", "/home/n")).toBe("/home/n/child.md");
    expect(resolveOpenPath("../sib.md", "/home/n/sub")).toBe("/home/n/sub/../sib.md");
    expect(resolveOpenPath("./child.md", "/home/n")).toBe("/home/n/./child.md");
  });
  it("leaves a ~ home path unchanged — the backend expands it, not the frontend", () => {
    expect(resolveOpenPath("~/notes/x.md", "/home/n")).toBe("~/notes/x.md");
    expect(resolveOpenPath("~", "/home/n")).toBe("~");
  });
  it("returns a Windows drive path unchanged", () => {
    expect(resolveOpenPath("C:\\notes\\x.md", "/home/n")).toBe("C:\\notes\\x.md");
    expect(resolveOpenPath("C:/notes/x.md", "/home/n")).toBe("C:/notes/x.md");
  });
  it("trims surrounding whitespace before resolving", () => {
    expect(resolveOpenPath("  child.md  ", "/home/n")).toBe("/home/n/child.md");
    expect(resolveOpenPath("  /a/b.md ", "/home/n")).toBe("/a/b.md");
  });
  it("returns null for blank input (refuse to open)", () => {
    expect(resolveOpenPath("", "/home/n")).toBeNull();
    expect(resolveOpenPath("   ", "/home/n")).toBeNull();
  });
  it("falls back to the bare relative path when baseDir is empty", () => {
    expect(resolveOpenPath("child.md", "")).toBe("child.md");
  });
});
