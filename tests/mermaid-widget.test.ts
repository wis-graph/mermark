import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MermaidWidget,
  effectiveMermaidTheme,
  clampZoom,
  zoomAtCursor,
  attachPanZoom,
} from "../src/markdown/mermaid-widget";
import { panZoomSetting, themeForceSetting } from "../src/settings/app";

/** Build a host + a minimal svg-like element with stubbed geometry, since jsdom
 *  has no real layout. `rect` is what both host and svg return from
 *  getBoundingClientRect (so the cursor-anchored zoom math is deterministic). */
function fakeHostAndSvg(rect: { left: number; top: number } = { left: 0, top: 0 }): {
  host: HTMLElement;
  svg: SVGElement;
} {
  const host = document.createElement("div");
  (host as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () =>
    ({ left: rect.left, top: rect.top, width: 0, height: 0 }) as DOMRect;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  (svg as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () =>
    ({ left: rect.left, top: rect.top, width: 0, height: 0 }) as DOMRect;
  return { host, svg };
}

/** Controllable requestAnimationFrame so the rAF-coalesced pan can be driven
 *  deterministically: scheduled callbacks queue up, `flushRaf()` runs them, and
 *  cancelAnimationFrame removes a pending one (so we can assert no leak). The
 *  queue length is the "frames pending" count used to prove coalescing (a burst
 *  of mousemoves books exactly one frame, not N). */
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }>;
let rafSeq: number;
function installRafStub() {
  rafQueue = [];
  rafSeq = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++rafSeq;
    rafQueue.push({ id, cb });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue = rafQueue.filter((f) => f.id !== id);
  });
}
function flushRaf() {
  const pending = rafQueue;
  rafQueue = [];
  for (const f of pending) f.cb(0);
}

describe("clampZoom (zoom-bound rule: never below natural, never past 3×)", () => {
  it("clamps below 1 up to 1 (no shrinking below natural size)", () => {
    expect(clampZoom(0.5)).toBe(1);
  });
  it("passes a value within range through unchanged", () => {
    expect(clampZoom(2)).toBe(2);
  });
  it("clamps above 3 down to 3 (3× upper bound)", () => {
    expect(clampZoom(5)).toBe(3);
  });
  it("keeps natural size (1) as 1", () => {
    expect(clampZoom(1)).toBe(1);
  });
});

describe("zoomAtCursor (cursor-anchored zoom keeps the point under the cursor fixed)", () => {
  it("scaling 1→2 at cursor (100,50) sets translate = cursor − cursorInSvg×newScale", () => {
    const state = { scale: 1, translateX: 0, translateY: 0 };
    zoomAtCursor(state, 100, 50, 2);
    // cursorInSvg = (100−0)/1 = 100; translate = 100 − 100×2 = −100
    expect(state.scale).toBe(2);
    expect(state.translateX).toBe(-100);
    expect(state.translateY).toBe(-50);
  });

  it("the diagram point under the cursor maps back to the same screen point", () => {
    const state = { scale: 1.5, translateX: 30, translateY: 10 };
    const cx = 120;
    const cy = 80;
    const cursorInSvgX = (cx - state.translateX) / state.scale;
    zoomAtCursor(state, cx, cy, 3);
    // after: screenX = cursorInSvgX*scale + translateX should equal cx
    expect(cursorInSvgX * state.scale + state.translateX).toBeCloseTo(cx, 6);
  });
});

describe("attachPanZoom (CSS-transform pan/zoom handler — state transitions)", () => {
  beforeEach(() => installRafStub());
  afterEach(() => {
    vi.unstubAllGlobals();
    panZoomSetting.set("on");
  });

  it("does not throw in jsdom (defensive geometry reads)", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    expect(() => {
      const pz = attachPanZoom(host, svg);
      pz.destroy();
    }).not.toThrow();
  });

  it("sets transform-origin 0 0 on attach when panZoom is on", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    expect(svg.style.transformOrigin).toBe("0 0");
    pz.destroy();
  });

  it("mousedown → window mousemove → mouseup pans (svg transform translates) then ends", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    host.dispatchEvent(new MouseEvent("mousedown", { clientX: 10, clientY: 20 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 70 }));
    // pan now coalesces via rAF: the write lands on the next frame, not inline.
    flushRaf();
    // translate = client − start = (40−10, 70−20) = (30, 50)
    expect(svg.style.transform).toContain("translate(30px, 50px)");
    window.dispatchEvent(new MouseEvent("mouseup", {}));
    // after mouseup, further mousemove must not pan (window listener removed)
    const after = svg.style.transform;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 200 }));
    flushRaf();
    expect(svg.style.transform).toBe(after);
    pz.destroy();
  });

  it("coalesces a burst of mousemoves into one frame, drawing the latest position", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    host.dispatchEvent(new MouseEvent("mousedown", { clientX: 10, clientY: 20 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 20, clientY: 30 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 60 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 70, clientY: 90 }));
    // three moves → exactly one frame booked (coalesced), nothing written yet
    expect(rafQueue.length).toBe(1);
    flushRaf();
    // the single frame draws the LATEST position: (70−10, 90−20) = (60, 70)
    expect(svg.style.transform).toContain("translate(60px, 70px)");
    window.dispatchEvent(new MouseEvent("mouseup", {}));
    pz.destroy();
  });

  it("mouseup cancels the pending frame (no leak) and flushes the final position", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    host.dispatchEvent(new MouseEvent("mousedown", { clientX: 10, clientY: 20 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 70 }));
    expect(rafQueue.length).toBe(1); // a frame is pending
    window.dispatchEvent(new MouseEvent("mouseup", {}));
    expect(rafQueue.length).toBe(0); // mouseup cancelled it → no dangling rAF
    // and the final position was flushed synchronously on mouseup
    expect(svg.style.transform).toContain("translate(30px, 50px)");
    pz.destroy();
  });

  it("dblclick toggles scale(1) → scale(2) → scale(1)+translate0", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    host.dispatchEvent(new MouseEvent("dblclick", { clientX: 0, clientY: 0 }));
    expect(svg.style.transform).toContain("scale(2)");
    host.dispatchEvent(new MouseEvent("dblclick", { clientX: 0, clientY: 0 }));
    expect(svg.style.transform).toContain("scale(1)");
    expect(svg.style.transform).toContain("translate(0px, 0px)");
    pz.destroy();
  });

  it("destroy() removes window listeners so a dangling drag can't pan", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    host.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0 }));
    pz.destroy();
    const before = svg.style.transform;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 99, clientY: 99 }));
    flushRaf();
    expect(svg.style.transform).toBe(before);
  });

  it("destroy() cancels a pending pan frame (no rAF outlives the widget)", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    host.dispatchEvent(new MouseEvent("mousedown", { clientX: 10, clientY: 20 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 70 }));
    expect(rafQueue.length).toBe(1); // a frame is pending
    const before = svg.style.transform;
    pz.destroy();
    expect(rafQueue.length).toBe(0); // destroy cancelled it
    flushRaf(); // even if something lingered, it must not redraw
    expect(svg.style.transform).toBe(before);
  });

  it("panZoom off: no transform, no transform-origin, no listeners (static)", () => {
    panZoomSetting.set("off");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    expect(svg.style.transformOrigin).toBe("");
    host.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 50, clientY: 50 }));
    expect(svg.style.transform).toBe("");
    host.dispatchEvent(new MouseEvent("dblclick", { clientX: 0, clientY: 0 }));
    expect(svg.style.transform).toBe("");
    expect(() => pz.destroy()).not.toThrow(); // off destroy is a safe no-op
  });
});

describe("attachPanZoom reset button (explicit return-to-natural-size affordance)", () => {
  beforeEach(() => installRafStub());
  afterEach(() => {
    vi.unstubAllGlobals();
    panZoomSetting.set("on");
  });

  it("appends a .cm-mermaid-reset button to the host when panZoom is on", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    const btn = host.querySelector<HTMLButtonElement>(".cm-mermaid-reset");
    expect(btn).not.toBeNull();
    expect(btn?.type).toBe("button");
    pz.destroy();
  });

  it("does NOT create a reset button when panZoom is off (static diagram)", () => {
    panZoomSetting.set("off");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    expect(host.querySelector(".cm-mermaid-reset")).toBeNull();
    pz.destroy();
  });

  it("toggles host.is-transformed: off at rest, on after a pan, off after reset", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    // at rest: not transformed
    expect(host.classList.contains("is-transformed")).toBe(false);
    // pan → transformed (the class flips when the coalesced frame writes)
    host.dispatchEvent(new MouseEvent("mousedown", { clientX: 10, clientY: 20 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 70 }));
    flushRaf();
    expect(host.classList.contains("is-transformed")).toBe(true);
    window.dispatchEvent(new MouseEvent("mouseup", {}));
    // reset click → back to natural, not transformed
    host.querySelector<HTMLButtonElement>(".cm-mermaid-reset")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(host.classList.contains("is-transformed")).toBe(false);
    pz.destroy();
  });

  it("reset click restores scale 1 / translate 0 on the svg transform", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    // zoom in first via dblclick
    host.dispatchEvent(new MouseEvent("dblclick", { clientX: 0, clientY: 0 }));
    expect(svg.style.transform).toContain("scale(2)");
    // reset
    host.querySelector<HTMLButtonElement>(".cm-mermaid-reset")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(svg.style.transform).toContain("scale(1)");
    expect(svg.style.transform).toContain("translate(0px, 0px)");
    pz.destroy();
  });

  it("reset button mousedown is swallowed (does not start a host pan)", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    const pz = attachPanZoom(host, svg);
    const btn = host.querySelector<HTMLButtonElement>(".cm-mermaid-reset")!;
    // mousedown on the button must not pan: stopPropagation prevents host's
    // onMouseDown from arming a drag, so a subsequent window mousemove is inert.
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 5 }));
    const before = svg.style.transform;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 99, clientY: 99 }));
    expect(svg.style.transform).toBe(before);
    pz.destroy();
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
