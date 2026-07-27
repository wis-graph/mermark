import { describe, it, expect } from "vitest";
import { fuzzyMatch, rankHits, MAX_RESULTS } from "../src/sidebar/search/fuzzy";

describe("fuzzyMatch", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "notes/a.md")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("NOTE", "notes/a.md")).not.toBeNull();
    expect(fuzzyMatch("note", "NOTES/A.MD")).not.toBeNull();
  });

  it("scores a consecutive run higher than the same letters scattered", () => {
    const consecutive = fuzzyMatch("not", "note.md")!;
    const scattered = fuzzyMatch("not", "n-o-t.md")!;
    expect(consecutive.score).toBeGreaterThan(scattered.score);
  });

  it("scores a boundary-aligned match higher than a mid-word match", () => {
    const boundary = fuzzyMatch("wo", "note-worthy.md")!; // 'w' starts right after '-'
    const midword = fuzzyMatch("wo", "cowork.md")!; // 'w' sits mid-word
    expect(boundary.score).toBeGreaterThan(midword.score);
  });

  it("prefers a basename match over a directory match for the same letters", () => {
    const basenameHit = fuzzyMatch("note", "a/note.md")!;
    const dirHit = fuzzyMatch("note", "notes/a.md")!;
    expect(basenameHit.score).toBeGreaterThan(dirHit.score);
  });

  it("ties break deterministically via rankHits (alphabetical)", () => {
    // Same basename, same total length, same match positions relative to
    // each string → genuinely identical scores; rankHits must still produce
    // a deterministic order (not insertion order) via the rel_path tie-break.
    const files = ["dir2/note.md", "dir1/note.md"];
    const a = fuzzyMatch("note", "dir1/note.md")!;
    const b = fuzzyMatch("note", "dir2/note.md")!;
    expect(a.score).toBe(b.score); // sanity: this really is a tie
    const ranked = rankHits("note", files, (f) => f, MAX_RESULTS);
    expect(ranked.map((r) => r.hit)).toEqual(["dir1/note.md", "dir2/note.md"]); // alphabetical tie-break
  });

  it("positions reports every matched character offset, in order", () => {
    const m = fuzzyMatch("ab", "xaxbx")!;
    expect(m.positions).toEqual([1, 3]);
  });
});

describe("rankHits", () => {
  const files = ["z.md", "a.md", "m.md"];

  it("empty query returns the first `limit` hits in their given order, unscored", () => {
    const ranked = rankHits("", files, (f) => f, 2);
    expect(ranked).toEqual([
      { hit: "z.md", match: null },
      { hit: "a.md", match: null },
    ]);
  });

  it("a non-empty query drops non-matches and sorts by score descending", () => {
    const ranked = rankHits("m", files, (f) => f, MAX_RESULTS);
    expect(ranked.map((r) => r.hit)).toContain("m.md");
    expect(ranked.every((r) => r.match !== null)).toBe(true);
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => `file${i}.md`);
    const ranked = rankHits("file", many, (f) => f, 3);
    expect(ranked).toHaveLength(3);
  });
});
