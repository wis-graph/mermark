import { describe, it, expect } from "vitest";
import { dirOf } from "../src/path";

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
