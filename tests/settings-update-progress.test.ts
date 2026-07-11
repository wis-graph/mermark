import { describe, it, expect } from "vitest";
import { downloadPercent, formatDownloadProgress } from "../src/settings/panel/update-progress";

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
});
