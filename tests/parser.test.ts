import { describe, it, expect } from "vitest";
import { scanWikilinks } from "../src/markdown/parser";

describe("scanWikilinks", () => {
  it("finds a single wikilink with start/end offsets and target", () => {
    const line = "see [[notes/foo]] now";
    expect(scanWikilinks(line, 0)).toEqual([{ from: 4, to: 17, target: "notes/foo", alias: "notes/foo" }]);
  });
  it("supports alias syntax [[target|alias]]", () => {
    const r = scanWikilinks("[[a/b|Bee]]", 0);
    expect(r[0]).toMatchObject({ target: "a/b", alias: "Bee" });
  });
  it("returns [] when none", () => {
    expect(scanWikilinks("no links here", 0)).toEqual([]);
  });
  it("applies a base offset to absolute positions", () => {
    const r = scanWikilinks("[[x]]", 100);
    expect(r[0].from).toBe(100);
  });
});
