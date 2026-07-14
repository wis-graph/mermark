import { describe, it, expect } from "vitest";
import { pushFavorite, removeFavorite, isFavorite, reorderFavorite } from "../src/sidebar/favorites/favorite-folders";

// favorite-folders.ts is a CURATION list (append + no cap + no auto-prune),
// the opposite domain from recent-docs.ts's MRU list (prepend + cap + prune)
// — see the module header for the full contrast table.

describe("pushFavorite", () => {
  it("adds a single item to an empty list", () => {
    expect(pushFavorite([], "/a/b")).toEqual(["/a/b"]);
  });

  it("appends (does not prepend) — insertion order is kept", () => {
    const list = pushFavorite(pushFavorite([], "/a"), "/b");
    expect(list).toEqual(["/a", "/b"]);
  });

  it("dedupes without moving the existing entry to the front", () => {
    expect(pushFavorite(["/a", "/b"], "/a")).toEqual(["/a", "/b"]);
  });

  it("dedupes across normalization-equivalent forms", () => {
    expect(pushFavorite(["/a/b"], "/a/b/")).toEqual(["/a/b"]);
    expect(pushFavorite(["/a/b"], "/a/./b")).toEqual(["/a/b"]);
  });

  it("has no cap — pushing many items keeps them all", () => {
    let list: string[] = [];
    for (let i = 0; i < 20; i++) list = pushFavorite(list, `/folder-${i}`);
    expect(list.length).toBe(20);
  });
});

describe("removeFavorite", () => {
  it("removes the matching entry", () => {
    expect(removeFavorite(["/a", "/b"], "/a")).toEqual(["/b"]);
  });

  it("removes a normalization-equivalent variant", () => {
    expect(removeFavorite(["/a", "/b"], "/a/")).toEqual(["/b"]);
  });

  it("is a no-op when the path isn't in the list", () => {
    expect(removeFavorite(["/a"], "/c")).toEqual(["/a"]);
  });
});

describe("isFavorite", () => {
  it("is true for a present path", () => {
    expect(isFavorite(["/a"], "/a")).toBe(true);
  });

  it("is false for an absent path", () => {
    expect(isFavorite(["/a"], "/c")).toBe(false);
  });

  it("matches a normalization-equivalent variant", () => {
    expect(isFavorite(["/a"], "/a/")).toBe(true);
  });
});

// reorderFavorite: user-driven curation only (drag/keyboard) — never called
// automatically, unlike recent-docs' MRU reordering. See favorite-folders.ts
// header for the curation-vs-MRU domain contrast.
describe("reorderFavorite", () => {
  it("moves an item from front to back", () => {
    expect(reorderFavorite(["/a", "/b", "/c"], "/a", 2)).toEqual(["/b", "/c", "/a"]);
  });

  it("moves an item from back to front", () => {
    expect(reorderFavorite(["/a", "/b", "/c"], "/c", 0)).toEqual(["/c", "/a", "/b"]);
  });

  it("clamps a negative toIndex to 0", () => {
    expect(reorderFavorite(["/a", "/b", "/c"], "/c", -5)).toEqual(["/c", "/a", "/b"]);
  });

  it("clamps a toIndex past the end to len-1", () => {
    expect(reorderFavorite(["/a", "/b", "/c"], "/a", 99)).toEqual(["/b", "/c", "/a"]);
  });

  it("is a no-op (content) when the path isn't in the list", () => {
    expect(reorderFavorite(["/a", "/b"], "/z", 0)).toEqual(["/a", "/b"]);
  });

  it("returns the SAME reference when the move is a no-op (already in place)", () => {
    const list = ["/a", "/b", "/c"];
    expect(reorderFavorite(list, "/b", 1)).toBe(list);
  });

  it("finds the target via normalization equivalence (/a/ ≡ /a)", () => {
    expect(reorderFavorite(["/a", "/b", "/c"], "/a/", 2)).toEqual(["/b", "/c", "/a"]);
  });
});
