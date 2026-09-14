import { describe, it, expect } from "vitest";
import { isPathWithin } from "./path";

describe("isPathWithin", () => {
  it("matches an exact path against itself", () => {
    expect(isPathWithin("/a/b", "/a/b")).toBe(true);
  });

  it("matches a path nested under a posix ancestor", () => {
    expect(isPathWithin("/a/b/c.md", "/a/b")).toBe(true);
  });

  it("matches a path nested under a windows ancestor", () => {
    expect(isPathWithin("C:\\a\\b\\c.md", "C:\\a\\b")).toBe(true);
  });

  it("rejects a sibling whose name merely extends the ancestor's", () => {
    expect(isPathWithin("/a/bc", "/a/b")).toBe(false);
  });

  it("rejects an unrelated path", () => {
    expect(isPathWithin("/x/y", "/a/b")).toBe(false);
  });

  // N6: the empty-string ancestor is REMOTE_VAULT_WIRE_ROOT
  // (workspace/workspace-state.ts) — a remote vault's wire-relative paths
  // (e.g. dirOf("sub/note.md") === "sub", dirOf("note.md") === "") carry no
  // leading separator, so the old `path.startsWith(ancestor + "/")` rule
  // always missed them and reported every remote sub-folder note as NOT
  // within the vault root, collapsing the explorer tree on every click.
  it("treats every path as within the empty-string vault root", () => {
    expect(isPathWithin("sub", "")).toBe(true);
    expect(isPathWithin("sub/note.md", "")).toBe(true);
    expect(isPathWithin("", "")).toBe(true);
  });
});
