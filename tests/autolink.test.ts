import { describe, it, expect } from "vitest";
import { autolinkHref } from "../src/markdown/live-preview/features/autolink";

describe("autolinkHref", () => {
  it("prefixes a scheme-less www. host with https://", () => {
    expect(autolinkHref("www.example.com")).toBe("https://www.example.com");
  });
  it("prefixes a scheme-less email with mailto:", () => {
    expect(autolinkHref("a@b.com")).toBe("mailto:a@b.com");
  });
  it("leaves an https:// URL unchanged", () => {
    expect(autolinkHref("https://example.com")).toBe("https://example.com");
  });
  it("leaves an http:// URL unchanged", () => {
    expect(autolinkHref("http://example.com")).toBe("http://example.com");
  });
  it("leaves an already-prefixed mailto: unchanged", () => {
    expect(autolinkHref("mailto:a@b.com")).toBe("mailto:a@b.com");
  });
});
