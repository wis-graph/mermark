import { describe, it, expect } from "vitest";
import { describeWindowsLag } from "../scripts/lib/describe-windows-lag.mjs";

describe("describeWindowsLag", () => {
  it("counts consecutive stale releases and finds the last one that had windows", () => {
    const releases = [
      { tag: "v0.6.2", hasWindows: false },
      { tag: "v0.6.1", hasWindows: false },
      { tag: "v0.6.0", hasWindows: true },
      { tag: "v0.5.12", hasWindows: false },
    ];
    expect(describeWindowsLag(releases)).toEqual({ staleCount: 2, lastWindowsTag: "v0.6.0" });
  });

  it("reports zero stale when the most recent past release had windows", () => {
    const releases = [{ tag: "v0.6.0", hasWindows: true }];
    expect(describeWindowsLag(releases)).toEqual({ staleCount: 0, lastWindowsTag: "v0.6.0" });
  });

  it("reports lastWindowsTag: null when no release in history ever shipped windows", () => {
    const releases = [
      { tag: "v0.5.12", hasWindows: false },
      { tag: "v0.5.11", hasWindows: false },
    ];
    expect(describeWindowsLag(releases)).toEqual({ staleCount: 2, lastWindowsTag: null });
  });

  it("handles empty history (first-ever release)", () => {
    expect(describeWindowsLag([])).toEqual({ staleCount: 0, lastWindowsTag: null });
  });
});
