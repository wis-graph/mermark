import { describe, it, expect } from "vitest";
import {
  dirOf,
  basename,
  resolveOpenPath,
  isBlankPath,
  formatRootLabel,
  normalizePath,
  breadcrumbSegments,
  isPathWithin,
  isResolvedAbsolutePath,
  windowsPathPrefix,
  isFilesystemRoot,
} from "../src/document/path";

describe("isResolvedAbsolutePath", () => {
  it("accepts a posix root", () => {
    expect(isResolvedAbsolutePath("/Users/tester/notes")).toBe(true);
  });
  it("accepts a Windows drive path with either separator", () => {
    expect(isResolvedAbsolutePath("C:\\Users\\tester")).toBe(true);
    expect(isResolvedAbsolutePath("C:/Users/tester")).toBe(true);
  });
  it("accepts a Windows UNC path", () => {
    expect(isResolvedAbsolutePath("\\\\server\\share")).toBe(true);
  });
  it("rejects a literal unresolved tilde — the Windows-home failure symptom", () => {
    // This is exactly what a resolved `canonicalize_path("~")` looks like
    // when the backend's home lookup fails (expand_home's documented
    // literal-fallback contract, src-tauri/src/fs/paths.rs): callers must
    // NOT treat it as a usable absolute root.
    expect(isResolvedAbsolutePath("~")).toBe(false);
  });
  it("rejects a plain relative path", () => {
    expect(isResolvedAbsolutePath("notes/x.md")).toBe(false);
  });
});

describe("normalizePath", () => {
  // Parity with backend `fs/paths.rs:378 test_normalize_path_resolves_dot_dot_and_dot`
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

  // Windows verbatim (`\\?\`) / UNC prefix preservation — the explorer's
  // "내 컴퓨터" defect fix. Without this, `\\?\C:\Users\x\..` was parsed as a
  // posix-rooted path (`?`, `C:` becoming ordinary segments) and corrupted.
  it("preserves a verbatim drive prefix (`\\\\?\\C:`) and never pops below it", () => {
    expect(normalizePath("\\\\?\\C:\\Users\\x\\..")).toBe("\\\\?\\C:\\Users");
    expect(normalizePath("\\\\?\\C:\\..")).toBe("\\\\?\\C:\\");
  });
  it("preserves a verbatim UNC prefix (`\\\\?\\UNC\\srv\\share`) and never pops below it", () => {
    expect(normalizePath("\\\\?\\UNC\\srv\\share\\d\\..\\..")).toBe("\\\\?\\UNC\\srv\\share");
  });
  it("preserves a plain UNC prefix (`\\\\srv\\share`) and never pops below it", () => {
    expect(normalizePath("\\\\srv\\share\\d\\..")).toBe("\\\\srv\\share");
    expect(normalizePath("\\\\srv\\share\\..")).toBe("\\\\srv\\share");
  });
  it("normalizes mixed separators against a Windows prefix as `\\` (prefix wins the separator)", () => {
    expect(normalizePath("C:\\Users\\x/..")).toBe("C:\\Users");
    expect(normalizePath("\\\\srv\\share/..")).toBe("\\\\srv\\share");
  });
});

describe("windowsPathPrefix", () => {
  it("recognizes a verbatim drive prefix", () => {
    expect(windowsPathPrefix("\\\\?\\C:\\Users")).toBe("\\\\?\\C:");
  });
  it("recognizes a verbatim UNC prefix", () => {
    expect(windowsPathPrefix("\\\\?\\UNC\\srv\\share\\d")).toBe("\\\\?\\UNC\\srv\\share");
  });
  it("recognizes a plain UNC prefix", () => {
    expect(windowsPathPrefix("\\\\srv\\share\\d")).toBe("\\\\srv\\share");
  });
  it("recognizes a plain drive prefix", () => {
    expect(windowsPathPrefix("C:\\x")).toBe("C:");
  });
  it("returns \"\" for a posix path", () => {
    expect(windowsPathPrefix("/x")).toBe("");
  });
  it("returns \"\" for an incomplete verbatim prefix (not a recognized shape)", () => {
    expect(windowsPathPrefix("\\\\?\\")).toBe("");
  });
});

describe("isFilesystemRoot", () => {
  it("accepts a posix root", () => {
    expect(isFilesystemRoot("/")).toBe(true);
  });
  it("accepts a Windows drive root, any separator spelling", () => {
    expect(isFilesystemRoot("C:")).toBe(true);
    expect(isFilesystemRoot("C:\\")).toBe(true);
    expect(isFilesystemRoot("C:/")).toBe(true);
  });
  it("accepts a Windows UNC share root, with or without a trailing separator", () => {
    expect(isFilesystemRoot("\\\\srv\\share")).toBe(true);
    expect(isFilesystemRoot("\\\\srv\\share\\")).toBe(true);
  });
  it("accepts a verbatim drive root", () => {
    expect(isFilesystemRoot("\\\\?\\C:\\")).toBe(true);
  });
  it("rejects a non-root path", () => {
    expect(isFilesystemRoot("/Users")).toBe(false);
    expect(isFilesystemRoot("C:\\Users")).toBe(false);
    expect(isFilesystemRoot("\\\\srv\\share\\docs")).toBe(false);
  });
  it("rejects empty, home-literal, and relative input", () => {
    expect(isFilesystemRoot("")).toBe(false);
    expect(isFilesystemRoot("~")).toBe(false);
    expect(isFilesystemRoot("relative")).toBe(false);
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

describe("basename", () => {
  it("returns the file name of an absolute posix path", () => {
    expect(basename("/Users/x/notes/foo.md")).toBe("foo.md");
  });
  it("returns the file name of a relative path", () => {
    expect(basename("notes/foo.md")).toBe("foo.md");
  });
  it("returns the whole string for a bare filename (no separator)", () => {
    expect(basename("foo.md")).toBe("foo.md");
  });
  it("returns the file name for a root-level file", () => {
    expect(basename("/foo.md")).toBe("foo.md");
  });
  it("handles windows backslash separators", () => {
    expect(basename("C:\\Users\\x\\foo.md")).toBe("foo.md");
  });
  it("handles empty input", () => {
    expect(basename("")).toBe("");
  });
  it("agrees with dirOf on the split point (dirOf + sep + basename reconstructs the path)", () => {
    const p = "/Users/x/notes/foo.md";
    expect(`${dirOf(p)}/${basename(p)}`).toBe(p);
  });
});

// Promoted from workspace/cli-routing.ts's private `isWithinRoot` — same
// boundary contract, now shared with the explorer panel's `showsFolderOf`
// (2026-08-25 folder-collapse regression fix).
describe("isPathWithin", () => {
  it("is within itself (identical path)", () => {
    expect(isPathWithin("/a", "/a")).toBe(true);
  });
  it("is within a proper ancestor", () => {
    expect(isPathWithin("/a/b", "/a")).toBe(true);
  });
  it("boundary: a sibling whose name merely EXTENDS the ancestor's is NOT within it (/a/bc vs /a/b)", () => {
    expect(isPathWithin("/a/bc", "/a/b")).toBe(false);
  });
  it("a strictly unrelated path is not within it", () => {
    expect(isPathWithin("/other/doc.md", "/root")).toBe(false);
  });
  it("handles windows backslash separators", () => {
    expect(isPathWithin("C:\\a\\b", "C:\\a")).toBe(true);
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

describe("breadcrumbSegments", () => {
  it("posix non-home path: leading `/` root node + each ancestor accumulated", () => {
    expect(breadcrumbSegments("/etc/nginx")).toEqual([
      { label: "/", abs: "/" },
      { label: "etc", abs: "/etc" },
      { label: "nginx", abs: "/etc/nginx" },
    ]);
  });

  it("home path: `~` label but abs is the REAL home path, ancestors accumulate off it", () => {
    expect(breadcrumbSegments("/Users/wis/docs/superpowers/plans")).toEqual([
      { label: "~", abs: "/Users/wis" },
      { label: "docs", abs: "/Users/wis/docs" },
      { label: "superpowers", abs: "/Users/wis/docs/superpowers" },
      { label: "plans", abs: "/Users/wis/docs/superpowers/plans" },
    ]);
  });

  it("home itself is a single `~` node with abs = the real home path", () => {
    expect(breadcrumbSegments("/Users/wis")).toEqual([{ label: "~", abs: "/Users/wis" }]);
    expect(breadcrumbSegments("/home/u")).toEqual([{ label: "~", abs: "/home/u" }]);
  });

  it("root path is a single segment (never empty)", () => {
    expect(breadcrumbSegments("/")).toEqual([{ label: "/", abs: "/" }]);
  });

  it("windows drive (non-home): drive-root node then ancestors", () => {
    expect(breadcrumbSegments("C:\\Windows\\System32")).toEqual([
      { label: "C:", abs: "C:\\" },
      { label: "Windows", abs: "C:\\Windows" },
      { label: "System32", abs: "C:\\Windows\\System32" },
    ]);
  });

  it("windows home: abbreviates to `~`, sep stays `\\`", () => {
    expect(breadcrumbSegments("C:\\Users\\u\\proj")).toEqual([
      { label: "~", abs: "C:\\Users\\u" },
      { label: "proj", abs: "C:\\Users\\u\\proj" },
    ]);
  });

  it("literal `~` is a single unexpanded node", () => {
    expect(breadcrumbSegments("~")).toEqual([{ label: "~", abs: "~" }]);
  });

  it("empty path yields no segments", () => {
    expect(breadcrumbSegments("")).toEqual([]);
  });

  it("round-trips: every segment's abs is already canonical (normalizePath is a no-op on it)", () => {
    const cases = [
      "/etc/nginx",
      "/Users/wis/docs/superpowers/plans",
      "/Users/wis",
      "/",
      "C:\\Windows\\System32",
      "C:\\Users\\u\\proj",
      "~",
    ];
    for (const path of cases) {
      for (const seg of breadcrumbSegments(path)) {
        expect(normalizePath(seg.abs)).toBe(seg.abs);
      }
    }
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
