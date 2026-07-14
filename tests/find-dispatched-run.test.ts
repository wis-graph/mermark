import { describe, it, expect } from "vitest";
import { findDispatchedRun } from "../scripts/lib/find-dispatched-run.mjs";

describe("findDispatchedRun", () => {
  it("ignores a stale run created before `since` (the retry-after-failure bug)", () => {
    // This is exactly the bug the team lead flagged: `gh run list --limit 1`
    // on a retry would grab yesterday's failed run and report failure
    // immediately, without ever looking at the new dispatch.
    const runs = [
      { databaseId: 1, createdAt: "2026-07-14T10:00:00Z", event: "workflow_dispatch" }, // stale, before `since`
    ];
    expect(findDispatchedRun(runs, "2026-07-14T12:00:00Z")).toBeNull();
  });

  it("picks the run created after `since`", () => {
    const runs = [
      { databaseId: 1, createdAt: "2026-07-14T10:00:00Z", event: "workflow_dispatch" },
      { databaseId: 2, createdAt: "2026-07-14T12:00:05Z", event: "workflow_dispatch" },
    ];
    const match = findDispatchedRun(runs, "2026-07-14T12:00:00Z");
    expect(match?.databaseId).toBe(2);
  });

  it("excludes runs from other trigger events even if recent", () => {
    const runs = [
      { databaseId: 3, createdAt: "2026-07-14T12:00:05Z", event: "push" },
      { databaseId: 4, createdAt: "2026-07-14T12:00:10Z", event: "workflow_dispatch" },
    ];
    const match = findDispatchedRun(runs, "2026-07-14T12:00:00Z");
    expect(match?.databaseId).toBe(4);
  });

  it("returns the earliest qualifying run when several dispatches raced in", () => {
    const runs = [
      { databaseId: 6, createdAt: "2026-07-14T12:00:20Z", event: "workflow_dispatch" },
      { databaseId: 5, createdAt: "2026-07-14T12:00:05Z", event: "workflow_dispatch" },
    ];
    const match = findDispatchedRun(runs, "2026-07-14T12:00:00Z");
    expect(match?.databaseId).toBe(5);
  });

  it("returns null when nothing qualifies yet (still polling)", () => {
    expect(findDispatchedRun([], "2026-07-14T12:00:00Z")).toBeNull();
  });

  it("throws on an invalid since timestamp", () => {
    expect(() => findDispatchedRun([], "not-a-date")).toThrow(/invalid "since"/);
  });
});
