import { describe, it, expect } from "vitest";
import {
  makeHistory,
  pushHistory,
  back,
  forward,
  canBack,
  canForward,
  currentEntry,
  pruneAt,
  HISTORY_CAP,
} from "../src/history/nav-history";

// Pure back/forward stack arithmetic (recent-docs.ts style): no DOM, no IO.
// DISTINCT from the recent MRU list — duplicates allowed, pointer + forward
// truncation, no persistence.

describe("nav-history: pure stack arithmetic (B)", () => {
  it("makeHistory() starts empty; makeHistory(x) seeds one entry", () => {
    expect(makeHistory().entries).toEqual([]);
    expect(currentEntry(makeHistory())).toBeUndefined();
    const h = makeHistory("A");
    expect(h.entries).toEqual(["A"]);
    expect(h.index).toBe(0);
    expect(currentEntry(h)).toBe("A");
  });

  it("pushHistory appends and advances the index", () => {
    let h = makeHistory("A");
    h = pushHistory(h, "B");
    expect(h.entries).toEqual(["A", "B"]);
    expect(h.index).toBe(1);
  });

  it("pushHistory allows duplicates (A→B→A keeps three entries)", () => {
    let h = makeHistory("A");
    h = pushHistory(h, "B");
    h = pushHistory(h, "A");
    expect(h.entries).toEqual(["A", "B", "A"]);
    expect(h.index).toBe(2);
  });

  it("pushHistory truncates the forward branch after back", () => {
    let h = makeHistory("A");
    h = pushHistory(h, "B");
    h = pushHistory(h, "C"); // A,B,C idx2
    h = back(h);
    h = back(h); // idx0 (A)
    h = pushHistory(h, "D"); // forward(B,C) truncated → A,D idx1
    expect(h.entries).toEqual(["A", "D"]);
    expect(h.index).toBe(1);
  });

  it("canBack / canForward at the ends", () => {
    let h = makeHistory("A");
    expect(canBack(h)).toBe(false);
    expect(canForward(h)).toBe(false);
    h = pushHistory(h, "B");
    expect(canBack(h)).toBe(true);
    expect(canForward(h)).toBe(false);
  });

  it("back/forward move the pointer; a no-op returns the SAME reference", () => {
    let h = makeHistory("A");
    h = pushHistory(h, "B");
    const back1 = back(h);
    expect(back1.index).toBe(0);
    expect(back(back1)).toBe(back1); // at start → same ref (no-op signal)
    const fwd = forward(back1);
    expect(fwd.index).toBe(1);
    expect(forward(fwd)).toBe(fwd); // at end → same ref
  });

  it("pushHistory clamps to HISTORY_CAP (oldest dropped, index fixed)", () => {
    let h = makeHistory("0");
    for (let i = 1; i <= HISTORY_CAP + 5; i++) h = pushHistory(h, String(i));
    expect(h.entries.length).toBe(HISTORY_CAP);
    expect(h.index).toBe(HISTORY_CAP - 1);
    expect(currentEntry(h)).toBe(String(HISTORY_CAP + 5));
  });

  it("pruneAt removes a dead entry and fixes the index", () => {
    let h = makeHistory("A");
    h = pushHistory(h, "B");
    h = pushHistory(h, "C"); // idx2
    h = pruneAt(h, 1); // remove B → A,C
    expect(h.entries).toEqual(["A", "C"]);
    expect(h.index).toBe(1); // C position corrected
  });

  it("pruneAt is a no-op for an out-of-range index", () => {
    const h = pushHistory(makeHistory("A"), "B");
    expect(pruneAt(h, 5)).toBe(h);
    expect(pruneAt(h, -1)).toBe(h);
  });
});
