import { describe, it, expect } from "vitest";
import { truncatedPathLabel, redundantPathLabel } from "../src/chrome/path-label";

describe("redundantPathLabel (path-label-vs-name-headline duplication rule)", () => {
  it("true for a bare filename with no directory component", () => {
    expect(redundantPathLabel("x.md")).toBe(true);
  });

  it("false when the path has a directory component", () => {
    expect(redundantPathLabel("/a/x.md")).toBe(false);
  });

  it("false for a nested relative path", () => {
    expect(redundantPathLabel("work/projects/x.md")).toBe(false);
  });

  it("true for a bare windows-style filename too", () => {
    expect(redundantPathLabel("x.md")).toBe(true); // no backslash either → basename === path
  });
});

describe("truncatedPathLabel (unchanged DOM builder)", () => {
  it("still builds a .path-label > bdi regardless of whether the caller decides to append it", () => {
    const el = truncatedPathLabel("/a/x.md");
    expect(el.className).toBe("path-label");
    expect(el.querySelector("bdi")?.textContent).toBe("/a/x.md");
  });
});
