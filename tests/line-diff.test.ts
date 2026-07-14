import { describe, it, expect } from "vitest";
import { diffLines, toDiffLines } from "../src/document/diff/line-diff";

describe("diffLines (conflict modal line diff)", () => {
  it("marks every row 'same' for identical input", () => {
    const rows = diffLines(["a", "b", "c"], ["a", "b", "c"]);
    expect(rows.map((r) => r.kind)).toEqual(["same", "same", "same"]);
    expect(rows[0].local).toBe("a");
    expect(rows[0].external).toBe("a");
  });

  it("reports a single added line", () => {
    const rows = diffLines(["a", "b"], ["a", "b", "c"]);
    expect(rows.filter((r) => r.kind === "added").map((r) => r.external)).toEqual(["c"]);
    expect(rows.filter((r) => r.kind === "removed")).toHaveLength(0);
  });

  it("reports a single removed line", () => {
    const rows = diffLines(["a", "b", "c"], ["a", "c"]);
    expect(rows.filter((r) => r.kind === "removed").map((r) => r.local)).toEqual(["b"]);
    expect(rows.filter((r) => r.kind === "added")).toHaveLength(0);
  });

  it("reports a replaced line as removed + added", () => {
    const rows = diffLines(["a", "x", "c"], ["a", "y", "c"]);
    expect(rows.some((r) => r.kind === "removed" && r.local === "x")).toBe(true);
    expect(rows.some((r) => r.kind === "added" && r.external === "y")).toBe(true);
  });

  it("handles empty input on both sides", () => {
    expect(diffLines([], [])).toEqual([]);
    expect(diffLines([], ["a"])).toEqual([{ kind: "added", external: "a" }]);
    expect(diffLines(["a"], [])).toEqual([{ kind: "removed", local: "a" }]);
  });

  it("toDiffLines drops a single trailing newline (no phantom empty row)", () => {
    expect(toDiffLines("a\nb\n")).toEqual(["a", "b"]);
    expect(toDiffLines("a\nb")).toEqual(["a", "b"]);
  });
});
