import { describe, it, expect } from "vitest";
import { isUrl, linkWrap } from "../src/markdown/paste-link";

describe("isUrl", () => {
  it("accepts a single http(s) url", () => {
    expect(isUrl("https://example.com")).toBe(true);
    expect(isUrl("http://example.com/a/b?c=d")).toBe(true);
  });
  it("trims surrounding whitespace", () => {
    expect(isUrl("  https://example.com\n")).toBe(true);
  });
  it("rejects non-url clipboard payloads (→ normal paste)", () => {
    expect(isUrl("just some text")).toBe(false); // has a space
    expect(isUrl("www.example.com")).toBe(false); // no scheme (minimum is http/https)
    expect(isUrl("mailto:a@b.com")).toBe(false);
    expect(isUrl("ftp://host/file")).toBe(false);
    expect(isUrl("")).toBe(false);
  });
  it("rejects a url with trailing text or a second token", () => {
    expect(isUrl("https://example.com and more")).toBe(false);
    expect(isUrl("see https://example.com")).toBe(false);
  });
  it("rejects multi-line payloads", () => {
    expect(isUrl("https://a.com\nhttps://b.com")).toBe(false);
  });
});

describe("linkWrap", () => {
  it("wraps selected text as a markdown link", () => {
    expect(linkWrap("Anthropic", "https://anthropic.com")).toBe("[Anthropic](https://anthropic.com)");
  });
  it("preserves the selected text verbatim", () => {
    expect(linkWrap("a [b] c", "https://x.com")).toBe("[a [b] c](https://x.com)");
  });
});
