import { describe, it, expect } from "vitest";
import { dropFences } from "../src/markdown/live-preview/core";

describe("dropFences", () => {
  it("drops the opening fence and the closing fence", () => {
    expect(dropFences(["```ts", "a", "b", "```"])).toEqual(["a", "b"]);
  });

  it("drops only the opening fence when the block is unclosed", () => {
    expect(dropFences(["```ts", "a", "b"])).toEqual(["a", "b"]);
  });

  it("handles an empty fenced body (opener immediately followed by closer)", () => {
    expect(dropFences(["```ts", "```"])).toEqual([]);
  });

  it("handles a lone opener (just the fence line)", () => {
    expect(dropFences(["```ts"])).toEqual([]);
  });

  it("recognizes a closing fence even with trailing whitespace", () => {
    expect(dropFences(["```", "x", "```  "])).toEqual(["x"]);
  });

  it("keeps interior blank lines", () => {
    expect(dropFences(["```", "a", "", "b", "```"])).toEqual(["a", "", "b"]);
  });
});
