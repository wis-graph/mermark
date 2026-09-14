import { describe, it, expect } from "vitest";
import { pushRecent, RECENT_CAP, type RecentEntry } from "../src/sidebar/recent/recent-docs";

// Pure list arithmetic: dedup (by path+vaultId pair) → front → cap
// (most-recent-first).

const entry = (path: string, vaultId = "vault-A"): RecentEntry => ({ path, vaultId });

describe("pushRecent", () => {
  it("prepends a new entry (most-recent-first)", () => {
    expect(pushRecent([entry("/b"), entry("/c")], entry("/a"))).toEqual([entry("/a"), entry("/b"), entry("/c")]);
  });

  it("dedupes a re-opened (path, vaultId) pair, moving it to the front", () => {
    expect(pushRecent([entry("/a"), entry("/b"), entry("/c")], entry("/c"))).toEqual([entry("/c"), entry("/a"), entry("/b")]);
  });

  it("caps the list length, dropping the oldest", () => {
    const list = Array.from({ length: RECENT_CAP }, (_, i) => entry(`/f${i}`));
    const next = pushRecent(list, entry("/new"));
    expect(next.length).toBe(RECENT_CAP);
    expect(next[0]).toEqual(entry("/new"));
    expect(next.some((e) => e.path === `/f${RECENT_CAP - 1}`)).toBe(false); // oldest fell off
  });

  it("respects a custom cap", () => {
    expect(pushRecent([entry("/a"), entry("/b")], entry("/c"), 2)).toEqual([entry("/c"), entry("/a")]);
  });

  // Task 11 fix round 3: a remote vault's path is only vault-relative
  // ("노트.md"), so two different remote vaults can legitimately share the
  // same path — deduping by path alone would wrongly conflate them into one
  // entry, silently dropping the other vault's history.
  it("keeps the SAME path in two different vaults as two distinct entries", () => {
    const remoteA = entry("노트.md", "vault-remote-A");
    const remoteB = entry("노트.md", "vault-remote-B");
    const next = pushRecent([remoteA], remoteB);
    expect(next).toEqual([remoteB, remoteA]);
  });

  it("re-pushing the same (path, vaultId) does not duplicate it", () => {
    const remoteA = entry("노트.md", "vault-remote-A");
    const next = pushRecent([remoteA, entry("/other")], remoteA);
    expect(next).toEqual([remoteA, entry("/other")]);
  });
});
