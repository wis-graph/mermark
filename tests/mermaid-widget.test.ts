import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MermaidWidget, effectiveMermaidTheme } from "../src/markdown/mermaid-widget";
import { panZoomSetting, themeForceSetting } from "../src/settings/app";

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

describe("effectiveMermaidTheme (themeForce override rule)", () => {
  afterEach(() => themeForceSetting.set("follow"));

  it("follows the app theme when themeForce is follow", () => {
    themeForceSetting.set("follow");
    expect(effectiveMermaidTheme("light")).toBe("default");
    expect(effectiveMermaidTheme("dark")).toBe("dark");
  });

  it("pins dark regardless of the app theme", () => {
    themeForceSetting.set("dark");
    expect(effectiveMermaidTheme("light")).toBe("dark");
    expect(effectiveMermaidTheme("dark")).toBe("dark");
  });

  it("pins light (mermaid 'default') regardless of the app theme", () => {
    themeForceSetting.set("light");
    expect(effectiveMermaidTheme("dark")).toBe("default");
    expect(effectiveMermaidTheme("light")).toBe("default");
  });
});

describe("MermaidWidget.eq captures panZoom (live toggle re-creates the widget)", () => {
  beforeEach(() => panZoomSetting.set("on"));
  afterEach(() => panZoomSetting.set("on"));

  it("is unequal across a panZoom toggle so CM re-creates the host", () => {
    panZoomSetting.set("on");
    const on = new MermaidWidget("graph TD");
    panZoomSetting.set("off");
    const off = new MermaidWidget("graph TD");
    expect(on.eq(off)).toBe(false);
  });

  it("stays equal when panZoom (and code/dims) are unchanged", () => {
    panZoomSetting.set("on");
    const a = new MermaidWidget("graph TD");
    const b = new MermaidWidget("graph TD");
    expect(a.eq(b)).toBe(true);
  });
});
