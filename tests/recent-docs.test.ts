import { describe, it, expect } from "vitest";
import { pushRecent, pruneMissing, RECENT_CAP } from "../src/recent/recent-docs";

// Pure list arithmetic: dedup → front → cap (most-recent-first), and prune a
// dead entry.

describe("pushRecent", () => {
  it("prepends a new path (most-recent-first)", () => {
    expect(pushRecent(["/b", "/c"], "/a")).toEqual(["/a", "/b", "/c"]);
  });

  it("dedupes a re-opened path, moving it to the front", () => {
    expect(pushRecent(["/a", "/b", "/c"], "/c")).toEqual(["/c", "/a", "/b"]);
  });

  it("caps the list length, dropping the oldest", () => {
    const list = Array.from({ length: RECENT_CAP }, (_, i) => `/f${i}`);
    const next = pushRecent(list, "/new");
    expect(next.length).toBe(RECENT_CAP);
    expect(next[0]).toBe("/new");
    expect(next).not.toContain(`/f${RECENT_CAP - 1}`); // oldest fell off
  });

  it("respects a custom cap", () => {
    expect(pushRecent(["/a", "/b"], "/c", 2)).toEqual(["/c", "/a"]);
  });
});

describe("pruneMissing", () => {
  it("removes the given path", () => {
    expect(pruneMissing(["/a", "/b", "/c"], "/b")).toEqual(["/a", "/c"]);
  });
  it("is a no-op when the path is absent", () => {
    expect(pruneMissing(["/a"], "/x")).toEqual(["/a"]);
  });
});
