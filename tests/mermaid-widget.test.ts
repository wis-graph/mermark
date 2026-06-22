import { describe, it, expect } from "vitest";
import { MermaidWidget } from "../src/markdown/mermaid-widget";

describe("MermaidWidget.eq with dimensions", () => {
  it("is equal when code and dims match (px declared)", () => {
    const a = new MermaidWidget("graph TD", { width: 300, height: null });
    const b = new MermaidWidget("graph TD", { width: 300, height: null });
    expect(a.eq(b)).toBe(true);
  });

  it("is unequal when a declared dimension differs (px decl changed → re-create)", () => {
    const a = new MermaidWidget("graph TD", { width: 400, height: null });
    const b = new MermaidWidget("graph TD", { width: 300, height: null });
    expect(a.eq(b)).toBe(false);
  });

  it("is equal for the same body with no dims (natural-size widgets match)", () => {
    const a = new MermaidWidget("graph TD");
    const b = new MermaidWidget("graph TD");
    expect(a.eq(b)).toBe(true);
  });

  it("is unequal when only the height axis differs", () => {
    const a = new MermaidWidget("graph TD", { width: 300, height: 400 });
    const b = new MermaidWidget("graph TD", { width: 300, height: null });
    expect(a.eq(b)).toBe(false);
  });

  it("is unequal when the body differs even with matching dims", () => {
    const a = new MermaidWidget("graph TD", { width: 300, height: null });
    const b = new MermaidWidget("graph LR", { width: 300, height: null });
    expect(a.eq(b)).toBe(false);
  });
});
