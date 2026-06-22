import { describe, it, expect } from "vitest";
import { parseDimensions } from "../src/markdown/live-preview/features/mermaid";

describe("parseDimensions", () => {
  it("parses a width-only first line and strips it from the body", () => {
    expect(parseDimensions("300\ngraph TD\n A-->B")).toEqual({
      width: 300,
      height: null,
      body: "graph TD\n A-->B",
    });
  });

  it("parses a height-only first line (leading comma) and strips it", () => {
    expect(parseDimensions(", 400\ngraph TD")).toEqual({
      width: null,
      height: 400,
      body: "graph TD",
    });
  });

  it("parses both width and height from the first line", () => {
    expect(parseDimensions("300, 400\nsequenceDiagram")).toEqual({
      width: 300,
      height: 400,
      body: "sequenceDiagram",
    });
  });

  it("keeps the first line when both dimensions are NaN (a real diagram line)", () => {
    // `graph TD` does not start with a digit → not a size declaration → kept.
    expect(parseDimensions("graph TD\n A-->B")).toEqual({
      width: null,
      height: null,
      body: "graph TD\n A-->B",
    });
  });

  it("accepts a `300px` part (parseInt leading-integer wins) per spec §2", () => {
    expect(parseDimensions("300px\ngraph TD")).toEqual({
      width: 300,
      height: null,
      body: "graph TD",
    });
  });

  it("FOOTGUN GUARD: a body whose first line is a bare number is taken as a size declaration", () => {
    // Spec §2 accepts this footgun: `42\nflowchart` strips `42` as a width.
    // This test pins the documented behavior so a future change can't silently
    // start keeping bare-number first lines (which would change rendering).
    expect(parseDimensions("42\nflowchart")).toEqual({
      width: 42,
      height: null,
      body: "flowchart",
    });
  });

  it("treats a single-line source with no declaration as the whole body", () => {
    expect(parseDimensions("graph TD")).toEqual({
      width: null,
      height: null,
      body: "graph TD",
    });
  });

  it("strips a declaration line even when the body is then empty", () => {
    expect(parseDimensions("300, 400")).toEqual({
      width: 300,
      height: 400,
      body: "",
    });
  });
});
