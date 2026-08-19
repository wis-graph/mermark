import { describe, it, expect } from "vitest";
import { downloadPercent, downloadStat, formatDownloadProgress } from "../src/update/update-progress";

describe("downloadPercent", () => {
  it("computes a 0-100 percentage from downloaded/total bytes", () => {
    const total = 9.8 * 1024 * 1024;
    const downloaded = 4.2 * 1024 * 1024;
    expect(downloadPercent(downloaded, total)).toBeCloseTo(42.857, 2);
  });

  it("returns null when total is unknown (no Content-Length)", () => {
    expect(downloadPercent(1024, null)).toBeNull();
  });

  it("returns null when total is zero or negative", () => {
    expect(downloadPercent(1024, 0)).toBeNull();
    expect(downloadPercent(1024, -1)).toBeNull();
  });

  it("clamps to 100 even if downloaded overshoots total", () => {
    expect(downloadPercent(200, 100)).toBe(100);
  });
});

describe("downloadStat", () => {
  it("formats percent + MB fraction with NO state-word prefix, when total is known", () => {
    const total = 9.8 * 1024 * 1024;
    const downloaded = 4.2 * 1024 * 1024;
    expect(downloadStat(downloaded, total)).toBe("43% (4.2 / 9.8 MB)");
  });

  it("falls back to a bytes-only readout when total is unknown", () => {
    const downloaded = 4.2 * 1024 * 1024;
    expect(downloadStat(downloaded, null)).toBe("4.2 MB");
  });

  it("never contains the '다운로드 중' state word — that's formatDownloadProgress's job, not this one's", () => {
    expect(downloadStat(4.2 * 1024 * 1024, 9.8 * 1024 * 1024)).not.toContain("다운로드 중");
    expect(downloadStat(4.2 * 1024 * 1024, null)).not.toContain("다운로드 중");
  });
});

describe("formatDownloadProgress", () => {
  it("formats percent + MB fraction when total is known", () => {
    const total = 9.8 * 1024 * 1024;
    const downloaded = 4.2 * 1024 * 1024;
    expect(formatDownloadProgress(downloaded, total)).toBe("다운로드 중... 43% (4.2 / 9.8 MB)");
  });

  it("falls back to a bytes-only caption when total is unknown", () => {
    const downloaded = 4.2 * 1024 * 1024;
    expect(formatDownloadProgress(downloaded, null)).toBe("다운로드 중... 4.2 MB");
  });

  // Locks the derivation the two functions share (feature-architect's design):
  // formatDownloadProgress must always equal the "다운로드 중... " prefix plus
  // EXACTLY downloadStat's output, so the status-bar caption (downloadStat)
  // and the settings 버전 pane caption (formatDownloadProgress) can never say
  // conflicting numbers for the same downloaded/total pair.
  it("is always the '다운로드 중... ' prefix plus downloadStat's own output — never an independent copy", () => {
    const cases: [number, number | null][] = [
      [4.2 * 1024 * 1024, 9.8 * 1024 * 1024],
      [1024, null],
      [0, 100],
    ];
    for (const [downloaded, total] of cases) {
      expect(formatDownloadProgress(downloaded, total)).toBe(`다운로드 중... ${downloadStat(downloaded, total)}`);
    }
  });
});
