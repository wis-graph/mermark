import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOpenUrl = vi.fn();

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: any[]) => mockOpenUrl(...args),
}));

import { isExternalUrl, openExternal } from "../src/markdown/open-external";

describe("isExternalUrl", () => {
  it.each([
    "https://a.b",
    "http://a.b",
    "mailto:x@y.com",
    "tel:+821012345678",
    "HTTPS://A.B", // case-insensitive
  ])("accepts %s", (url) => {
    expect(isExternalUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>",
    "vbscript:msgbox(1)",
    "./note.md",
    "../x",
    "note",
    "C:/docs/x.md",
    "#heading",
    "",
  ])("rejects %s", (url) => {
    expect(isExternalUrl(url)).toBe(false);
  });
});

describe("openExternal", () => {
  beforeEach(() => {
    mockOpenUrl.mockReset();
  });

  it("does not call openUrl for a disallowed scheme, and marks feedback", async () => {
    const el = document.createElement("a");
    await openExternal("javascript:alert(1)", el);
    expect(mockOpenUrl).not.toHaveBeenCalled();
    expect(el.classList.contains("cm-external-link-error")).toBe(true);
    expect(el.title).toBeTruthy();
  });

  it("marks feedback when openUrl rejects", async () => {
    mockOpenUrl.mockRejectedValue(new Error("boom"));
    const el = document.createElement("a");
    await openExternal("https://example.com", el);
    expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com");
    expect(el.classList.contains("cm-external-link-error")).toBe(true);
    expect(el.title).toContain("boom");
  });

  it("leaves feedback untouched when openUrl resolves", async () => {
    mockOpenUrl.mockResolvedValue(undefined);
    const el = document.createElement("a");
    await openExternal("https://example.com", el);
    expect(el.classList.contains("cm-external-link-error")).toBe(false);
    expect(el.title).toBe("");
  });

  it("does not throw when feedbackEl is omitted", async () => {
    mockOpenUrl.mockResolvedValue(undefined);
    await expect(openExternal("https://example.com")).resolves.toBeUndefined();
    mockOpenUrl.mockRejectedValue(new Error("boom"));
    await expect(openExternal("https://example.com")).resolves.toBeUndefined();
    await expect(openExternal("javascript:x")).resolves.toBeUndefined();
  });
});
