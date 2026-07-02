import { describe, it, expect } from "vitest";
import { dirOf, resolveOpenPath, isBlankPath, formatRootLabel, normalizePath } from "../src/path";

describe("normalizePath", () => {
  // Parity with backend `commands.rs:849 test_normalize_path_resolves_dot_dot_and_dot`
  // — the frontend/backend twins MUST agree, or the tree and the header drift.
  it("pops `..` against the preceding segment (backend parity)", () => {
    expect(normalizePath("/a/b/../c")).toBe("/a/c");
  });
  it("drops `.` (backend parity)", () => {
    expect(normalizePath("/a/./b/c")).toBe("/a/b/c");
  });
  it("resolves a relative path, collapsing leading `..` as a no-op (backend parity)", () => {
    expect(normalizePath("a/b/c/../../d")).toBe("a/d");
    expect(normalizePath("../a")).toBe("a");
  });

  // Bug-reproduction cases: cumulative `..` from repeated up-navigation.
  it("resolves a single trailing `..` to the parent", () => {
    expect(normalizePath("/root/child/..")).toBe("/root");
  });
  it("resolves two trailing `..` (two up-navigations)", () => {
    expect(normalizePath("/orig/a/b/../..")).toBe("/orig");
  });
  it("resolves three trailing `..` all the way to root — the `…/../../..` bug case", () => {
    expect(normalizePath("/orig/a/b/../../..")).toBe("/");
  });

  it("never climbs above the root", () => {
    expect(normalizePath("/..")).toBe("/");
    expect(normalizePath("/../..")).toBe("/");
  });

  it("collapses consecutive separators and trailing separators", () => {
    expect(normalizePath("/a//b")).toBe("/a/b");
    expect(normalizePath("/a/b/")).toBe("/a/b");
  });

  it("passes an already-canonical path through unchanged", () => {
    expect(normalizePath("/a/b/c")).toBe("/a/b/c");
  });

  it("treats `~` as a literal segment (no expansion, backend parity)", () => {
    expect(normalizePath("~/notes/..")).toBe("~");
    expect(normalizePath("~")).toBe("~");
  });

  it("preserves a Windows drive prefix and never pops below it", () => {
    expect(normalizePath("C:\\Users\\u\\..\\v")).toBe("C:\\Users\\v");
    expect(normalizePath("C:\\..")).toBe("C:\\");
  });
});

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

  it("always shows the last (current-folder) segment — never summarized away", () => {
    const out = formatRootLabel("/x/a/b/c/current");
    expect(out.endsWith("current")).toBe(true);
    expect(out).toBe("…/b/c/current");
  });

  it("keeps a `~/…/` prefix for long home-rooted paths (home context preserved)", () => {
    expect(formatRootLabel("/Users/u/a/b/c/d")).toBe("~/…/b/c/d");
  });

  it("uses a bare `…/` prefix for long non-home paths (unchanged)", () => {
    expect(formatRootLabel("/srv/x/a/b/c")).toBe("…/a/b/c");
  });

  it("passes root and bare-home through unchanged", () => {
    expect(formatRootLabel("/")).toBe("/");
    expect(formatRootLabel("~")).toBe("~");
  });

  it("passes a short home-relative path through unchanged", () => {
    expect(formatRootLabel("~/notes")).toBe("~/notes");
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
