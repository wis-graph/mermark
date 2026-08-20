import { describe, it, expect } from "vitest";
import { resolveFence, markdownBlockFences } from "../src/markdown/fence-types";

describe("fence-types SSOT (stage 1: mermaid widget + code fallback)", () => {
  it("resolves 'mermaid' to the widget spec", () => {
    expect(resolveFence("mermaid")).toEqual({ key: "mermaid", info: ["mermaid"], kind: "widget" });
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveFence("MerMaid ").key).toBe("mermaid");
    expect(resolveFence(" Mermaid").kind).toBe("widget");
  });

  it("falls back to the code kind for unregistered/empty info strings", () => {
    for (const info of ["js", "", "unknown-lang", "ts", "rs"]) {
      const spec = resolveFence(info);
      expect(spec.kind, `info=${JSON.stringify(info)}`).toBe("code");
      expect(spec.key, `info=${JSON.stringify(info)}`).toBe("code");
    }
  });
});

describe("fence-types SSOT (stage 2: ```highlight markdown-block)", () => {
  it("resolves 'highlight' to the markdown-block spec", () => {
    expect(resolveFence("highlight")).toEqual({
      key: "highlight",
      info: ["highlight"],
      kind: "markdown-block",
      node: "HighlightBlock",
      fenceNode: "HighlightFence",
      lineClass: "cm-highlight-block",
    });
  });

  it("is case-insensitive and trims whitespace", () => {
    const spec = resolveFence(" Highlight ");
    expect(spec.kind).toBe("markdown-block");
    if (spec.kind === "markdown-block") expect(spec.node).toBe("HighlightBlock");
  });

  it("markdownBlockFences() carries the highlight entry, node+fenceNode+lineClass required", () => {
    expect(markdownBlockFences()).toEqual([
      {
        key: "highlight",
        info: ["highlight"],
        kind: "markdown-block",
        node: "HighlightBlock",
        fenceNode: "HighlightFence",
        lineClass: "cm-highlight-block",
      },
    ]);
  });
});
