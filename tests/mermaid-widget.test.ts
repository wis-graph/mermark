import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MermaidWidget,
  effectiveMermaidTheme,
  displayedDiagramHeight,
} from "../src/markdown/mermaid-widget";
import { panZoomSetting, themeForceSetting } from "../src/settings/app";

/** Build a fake host + svg with stubbed geometry, since jsdom has no real layout.
 *  `viewBox` is the svg's aspect source; `shownWidth` is the svg's displayed
 *  width (what getBoundingClientRect().width returns after the CSS column cap);
 *  `hostHeight` is the host's rendered height used as the no-viewBox fallback. */
function fakeHostAndSvg(opts: {
  viewBox: string | null;
  shownWidth: number;
  hostHeight: number;
}): { host: HTMLElement; el: SVGSVGElement } {
  const host = document.createElement("div");
  (host as unknown as { getBoundingClientRect(): { height: number; width: number } }).getBoundingClientRect =
    () => ({ height: opts.hostHeight, width: opts.shownWidth }) as DOMRect;
  const el = {
    getAttribute: (name: string) => (name === "viewBox" ? opts.viewBox : null),
    getBoundingClientRect: () => ({ width: opts.shownWidth }) as DOMRect,
  } as unknown as SVGSVGElement;
  return { host, el };
}

describe("displayedDiagramHeight (empty-band fix — symptom 2)", () => {
  it("uses viewBox aspect × the SVG's displayed width (downscaled wide diagram)", () => {
    // wide diagram downscaled to the column: viewBox 1534×294, svg shown at 652
    const { host, el } = fakeHostAndSvg({ viewBox: "0 0 1534 294", shownWidth: 652, hostHeight: 153 });
    // 652 * (294/1534) ≈ 124.96
    expect(displayedDiagramHeight(host, el)).toBeCloseTo(652 * (294 / 1534), 1);
  });

  it("uses the SVG width, not the host's column width, for a narrow centered diagram", () => {
    // small diagram centered in a wide column: viewBox 200×100, svg natural 200,
    // but host (flex justify-center) is 652 wide. Height must follow the svg (200),
    // not the column (652) — else the box gets an empty band.
    const { host, el } = fakeHostAndSvg({ viewBox: "0 0 200 100", shownWidth: 200, hostHeight: 100 });
    expect(displayedDiagramHeight(host, el)).toBeCloseTo(200 * (100 / 200), 1); // 100
    expect(displayedDiagramHeight(host, el)).not.toBeCloseTo(652 * (100 / 200), 1); // not 326
  });

  it("parses comma-separated viewBox values", () => {
    const { host, el } = fakeHostAndSvg({ viewBox: "0,0,1000,500", shownWidth: 400, hostHeight: 999 });
    expect(displayedDiagramHeight(host, el)).toBeCloseTo(400 * (500 / 1000), 1); // 200
  });

  it("falls back to the host's rendered height when there is no viewBox", () => {
    const { host, el } = fakeHostAndSvg({ viewBox: null, shownWidth: 300, hostHeight: 142 });
    expect(displayedDiagramHeight(host, el)).toBe(142);
  });

  it("falls back when the viewBox is malformed", () => {
    const { host, el } = fakeHostAndSvg({ viewBox: "garbage", shownWidth: 300, hostHeight: 88 });
    expect(displayedDiagramHeight(host, el)).toBe(88);
  });

  it("CQS: it is a pure query — it does not mutate host.style.height", () => {
    const { host, el } = fakeHostAndSvg({ viewBox: "0 0 1534 294", shownWidth: 652, hostHeight: 153 });
    const before = host.style.height;
    displayedDiagramHeight(host, el);
    expect(host.style.height).toBe(before);
  });
});

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
