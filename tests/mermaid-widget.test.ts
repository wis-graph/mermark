import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MermaidWidget,
  effectiveMermaidTheme,
  clampZoom,
  zoomAtCursor,
  attachPanZoom,
  clampPanDelta,
  renderedTranslate,
  mermaidPaletteSource,
  mermaidThemeVariables,
  isPureWhite,
  mermaidNodeFill,
} from "../src/markdown/mermaid-widget";
import { panZoomSetting, themeForceSetting, themeJsonSetting } from "../src/settings/app";
import { builtInTheme } from "../src/settings/theme-schema";

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

describe("MermaidWidget fullscreen button (applySvg's dispatchOpenFullscreen)", () => {
  beforeEach(() => installRafStub());
  afterEach(() => {
    vi.unstubAllGlobals();
    panZoomSetting.set("on");
  });

  // applySvg is TS-private (compile-time only) — asserting the fullscreen
  // affordance means exercising it directly with a stub svg string rather
  // than waiting on the real mermaid.render() (~1.3MB, lazy-loaded), matching
  // this file's existing "drive attachPanZoom directly" style above.
  function renderStubSvg(code = "graph TD"): { host: HTMLElement; widget: MermaidWidget } {
    panZoomSetting.set("on");
    const widget = new MermaidWidget(code);
    const host = document.createElement("div");
    (widget as unknown as { applySvg(host: HTMLElement, svg: string): void }).applySvg(
      host,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    return { host, widget };
  }

  it("adds a .cm-mermaid-fullscreen button alongside the rendered svg", () => {
    const { host } = renderStubSvg();
    const btn = host.querySelector<HTMLButtonElement>(".cm-mermaid-fullscreen");
    expect(btn).not.toBeNull();
    expect(btn?.type).toBe("button");
  });

  it("adds the fullscreen button even when panZoom is off (independent of that setting)", () => {
    panZoomSetting.set("off");
    const widget = new MermaidWidget("graph TD");
    const host = document.createElement("div");
    (widget as unknown as { applySvg(host: HTMLElement, svg: string): void }).applySvg(
      host,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    expect(host.querySelector(".cm-mermaid-fullscreen")).not.toBeNull();
  });

  it("clicking the button dispatches a bubbling mermaid-open-fullscreen event carrying the svg's outerHTML", () => {
    const { host } = renderStubSvg();
    const svg = host.querySelector("svg")!;
    let captured: CustomEvent<{ svgHtml: string }> | undefined;
    document.body.appendChild(host); // event must bubble past host to document
    document.addEventListener("mermaid-open-fullscreen", (e) => {
      captured = e as CustomEvent<{ svgHtml: string }>;
    });
    host.querySelector<HTMLButtonElement>(".cm-mermaid-fullscreen")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(captured).toBeDefined();
    expect(captured?.detail.svgHtml).toBe(svg.outerHTML);
    host.remove();
  });

  it("the button's mousedown is swallowed (does not start a host pan drag)", () => {
    const { host } = renderStubSvg();
    const svg = host.querySelector("svg")!;
    const btn = host.querySelector<HTMLButtonElement>(".cm-mermaid-fullscreen")!;
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 5 }));
    const before = svg.getAttribute("style");
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 99, clientY: 99 }));
    expect(svg.getAttribute("style")).toBe(before);
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

describe("mermaidThemeVariables (mermaid palette derived from the app theme SSOT)", () => {
  afterEach(() => {
    themeForceSetting.set("follow");
    themeJsonSetting.set(builtInTheme("dark"));
  });

  it("derives from the light preset when themeJson is light (follow)", () => {
    themeForceSetting.set("follow");
    themeJsonSetting.set(builtInTheme("light"));
    const vars = mermaidThemeVariables("light");
    expect(vars.darkMode).toBe(false);
    expect(vars.background).toBe("#f5f5f5");
    // surface is pure white in the light preset (tour-02: nodes floated off the
    // off-white canvas) — mermaidNodeFill tints it toward bg instead of using it
    // verbatim (2026-07-12 design-polish pass ⑤).
    expect(vars.primaryColor).toBe("#fafafa");
    expect(vars.secondaryColor).toBe("#fafafa");
    expect(vars.primaryTextColor).toBe("#0c0a09"); // fg
    expect(vars.edgeLabelBackground).toBe("#f5f5f5"); // bg — fixes the grey label chip
  });

  it("leaves claude's non-white surface untouched (byte-identical to before ⑤)", () => {
    themeForceSetting.set("follow");
    themeJsonSetting.set(builtInTheme("claude"));
    const vars = mermaidThemeVariables("dark");
    expect(vars.primaryColor).toBe("#efe9de");
    expect(vars.secondaryColor).toBe("#efe9de");
  });

  it("derives from the dark preset when themeJson is dark (follow)", () => {
    themeForceSetting.set("follow");
    themeJsonSetting.set(builtInTheme("dark"));
    const vars = mermaidThemeVariables("dark");
    expect(vars.darkMode).toBe(true);
    expect(vars.background).toBe("#131110");
  });

  it("mermaidPaletteSource follows themeJson when themeForce is follow", () => {
    themeForceSetting.set("follow");
    themeJsonSetting.set(builtInTheme("light"));
    expect(mermaidPaletteSource("dark")).toEqual(builtInTheme("light").colors);
  });

  it("a themeForce pin overrides the live themeJson with the pinned preset's palette", () => {
    themeForceSetting.set("light");
    themeJsonSetting.set(builtInTheme("dark")); // live JSON theme is dark…
    expect(mermaidPaletteSource("dark")).toEqual(builtInTheme("light").colors); // …but pin wins
  });

  it("tracks a live custom themeJson edit immediately (e.g. a swatch drag)", () => {
    themeForceSetting.set("follow");
    themeJsonSetting.set({
      ...builtInTheme("dark"),
      colors: { ...builtInTheme("dark").colors, surface: "#222222" },
    });
    expect(mermaidThemeVariables("dark").primaryColor).toBe("#222222");
  });
});

describe("isPureWhite (2026-07-12 design-polish pass ⑤)", () => {
  it("recognizes #fff/#ffffff/white case-insensitively", () => {
    expect(isPureWhite("#fff")).toBe(true);
    expect(isPureWhite("#FFF")).toBe(true);
    expect(isPureWhite("#ffffff")).toBe(true);
    expect(isPureWhite("#FFFFFF")).toBe(true);
    expect(isPureWhite("white")).toBe(true);
    expect(isPureWhite("WHITE")).toBe(true);
  });

  it("rejects any non-white color", () => {
    expect(isPureWhite("#efe9de")).toBe(false);
    expect(isPureWhite("#f5f5f5")).toBe(false);
    expect(isPureWhite("#000000")).toBe(false);
  });
});

describe("mermaidNodeFill (2026-07-12 design-polish pass ⑤)", () => {
  it("mixes surface halfway toward bg when surface is pure white", () => {
    expect(mermaidNodeFill({ surface: "#ffffff", bg: "#f5f5f5" } as never)).toBe("#fafafa");
  });

  it("returns surface verbatim when it isn't pure white", () => {
    expect(mermaidNodeFill({ surface: "#efe9de", bg: "#131110" } as never)).toBe("#efe9de");
  });

  // Regression (code-auditor 🔴 #1, 2026-07-12): isPureWhite accepts the
  // shorthand "#fff" and the CSS keyword "white" too, but mixHex only parses
  // 6-digit hex — mermaidNodeFill must normalize to "#ffffff" before mixing,
  // not pass either non-6-digit form straight through.
  it("mixes correctly when surface is the shorthand #fff", () => {
    expect(mermaidNodeFill({ surface: "#fff", bg: "#f5f5f5" } as never)).toBe("#fafafa");
  });

  it("mixes correctly when surface is the CSS keyword white", () => {
    expect(mermaidNodeFill({ surface: "white", bg: "#f5f5f5" } as never)).toBe("#fafafa");
  });
});

describe("clampPanDelta (keyboard/wheel pan clamp: can't scroll past the end)", () => {
  it("content smaller than the host always clamps to 0 (nothing to scroll)", () => {
    const content = { start: 10, end: 40 }; // 30 wide
    const host = { start: 0, end: 100 }; // 100 wide — content fits entirely
    expect(clampPanDelta(50, content, host)).toBe(0);
    expect(clampPanDelta(-50, content, host)).toBe(0);
  });

  it("clamps a forward (positive) delta to the remaining slack before the content's start hits the host's start", () => {
    // content is 200 wide, host is 100 wide, content.start is 20px LEFT of
    // (i.e. already overflowing past) host.start → 20px of forward slack
    // before content.start would reach host.start (any further would open a
    // gap on that edge).
    const content = { start: -20, end: 180 };
    const host = { start: 0, end: 100 };
    expect(clampPanDelta(100, content, host)).toBe(20);
    expect(clampPanDelta(10, content, host)).toBe(10); // within slack: unclamped
  });

  it("clamps a backward (negative) delta to the remaining slack before the content's end hits the host's end", () => {
    // content.end is 220, host.end is 100 → 120px of backward slack.
    const content = { start: -100, end: 220 };
    const host = { start: 0, end: 100 };
    expect(clampPanDelta(-200, content, host)).toBe(-120);
    expect(clampPanDelta(-50, content, host)).toBe(-50); // within slack: unclamped
  });

  it("returns exactly 0 at the boundary (content edge already flush with host edge)", () => {
    const content = { start: 0, end: 300 };
    const host = { start: 0, end: 100 };
    expect(clampPanDelta(5, content, host)).toBe(0); // already flush at start
    const content2 = { start: -200, end: 100 };
    expect(clampPanDelta(-5, content2, host)).toBe(0); // already flush at end
  });

  it("+Infinity resolves to the max forward slack, -Infinity to the max backward slack, no NaN", () => {
    const content = { start: -20, end: 320 };
    const host = { start: 0, end: 100 };
    expect(clampPanDelta(Infinity, content, host)).toBe(20);
    expect(clampPanDelta(-Infinity, content, host)).toBe(-220);
    expect(Number.isNaN(clampPanDelta(Infinity, content, host))).toBe(false);
    expect(Number.isNaN(clampPanDelta(-Infinity, content, host))).toBe(false);
  });
});

describe("attachPanZoom.panBy (keyboard/wheel panning primitive)", () => {
  afterEach(() => panZoomSetting.set("on"));

  /** A host/content pair where content is deliberately larger than host on
   *  both axes, so panBy has real room to move (jsdom lays out everything at
   *  0×0, so both rects must be stubbed by hand). */
  function fakeOversizedHostAndContent(): { host: HTMLElement; svg: SVGElement } {
    const host = document.createElement("div");
    (host as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    // content starts flush with the host (typical initial centered/fit state)
    // but is much bigger, so there's plenty of backward slack on both axes.
    (svg as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 }) as DOMRect;
    return { host, svg };
  }

  it("panBy is a no-op returning {dx:0,dy:0} when the panZoom setting is off (the stub shape matches the real one)", () => {
    panZoomSetting.set("off");
    const { host, svg } = fakeOversizedHostAndContent();
    const pz = attachPanZoom(host, svg);
    expect(pz.panBy(50, 50)).toEqual({ dx: 0, dy: 0 });
    pz.destroy();
  });

  it("panBy moves the transform by the requested (unclamped) delta and returns the applied delta", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeOversizedHostAndContent();
    const pz = attachPanZoom(host, svg);
    const applied = pz.panBy(-30, -20); // negative: content moves up/left, plenty of backward slack
    expect(applied).toEqual({ dx: -30, dy: -20 });
    expect(svg.style.transform).toContain("translate(-30px, -20px)");
    pz.destroy();
  });

  it("panBy clamps at the edge: the content's start edge cannot pass the host's start edge", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeOversizedHostAndContent();
    const pz = attachPanZoom(host, svg);
    // content.start (0) === host.start (0) already, so 0 forward slack:
    // any positive delta clamps to 0.
    const applied = pz.panBy(50, 0);
    expect(applied).toEqual({ dx: 0, dy: 0 });
    expect(svg.style.transform).toContain("translate(0px, 0px)");
    pz.destroy();
  });

  it("panBy(0, -Infinity) jumps to the maximum backward slack (End-key semantics)", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeOversizedHostAndContent();
    const pz = attachPanZoom(host, svg);
    // backward slack on Y = content.bottom(400) - host.bottom(100) = 300
    const applied = pz.panBy(0, -Infinity);
    expect(applied).toEqual({ dx: 0, dy: -300 });
    expect(svg.style.transform).toContain("translate(0px, -300px)");
    pz.destroy();
  });

  it("panBy(dx, dy, { animate: true }) still clamps and animates (defaults to false when opts omitted, as asserted above)", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeOversizedHostAndContent();
    const pz = attachPanZoom(host, svg);
    const applied = pz.panBy(-30, -20, { animate: true });
    expect(applied).toEqual({ dx: -30, dy: -20 });
    expect(svg.style.transform).toContain("translate(-30px, -20px)");
    expect(svg.style.transition).toBe("transform 0.2s ease-out");
    pz.destroy();
  });
});

describe("renderedTranslate (the currently PAINTED translate, parsed off a computed transform)", () => {
  it("parses matrix(a,b,c,d,e,f): tx=e, ty=f", () => {
    expect(renderedTranslate("matrix(1, 0, 0, 1, 30, 50)", { x: -1, y: -1 })).toEqual({ x: 30, y: 50 });
  });

  it("parses matrix3d(...): tx/ty are the 13th/14th value (index 12/13, column-major)", () => {
    const m = Array(16).fill(0);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    m[12] = 42; // tx
    m[13] = -7; // ty
    expect(renderedTranslate(`matrix3d(${m.join(", ")})`, { x: -1, y: -1 })).toEqual({ x: 42, y: -7 });
  });

  it('falls back to the given fallback on "none" (no transform applied)', () => {
    expect(renderedTranslate("none", { x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
  });

  it("falls back on an empty string", () => {
    expect(renderedTranslate("", { x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
  });

  it("falls back on an unresolved literal — exactly what jsdom's getComputedStyle actually returns (it echoes the inline transform string verbatim instead of resolving a matrix)", () => {
    expect(renderedTranslate("translate(30px, 50px) scale(1)", { x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
  });

  it("falls back on garbage input, never throws", () => {
    expect(renderedTranslate("not-a-transform-at-all", { x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
  });
});

// ---------------------------------------------------------------------------
// Regression: v0.9.18 real-app bug report — "held-down PageDown flies the
// image off-screen" / "trackpad wheel jitters". Root cause (see panBy's own
// comment in mermaid-widget.ts for the full account): the OLD clamp read
// `getBoundingClientRect()` as "where is the content right now" and compared
// the REQUESTED delta against that. While a CSS transition is still animating
// toward a PRIOR panBy's target, the painted rect lags `state` — every call
// in a fast burst (key repeat, trackpad inertia) then sees the SAME stale,
// over-generous slack and keeps adding to `state`, which sails past the real
// boundary. The v0.9.18 patch banned animation on `panBy` entirely to route
// around this (a source-level premise standing in for a real fix).
//
// v0.9.19 fix: the clamp now targets the content's TARGET box, recovered via
// `base = rect − renderedTranslate(getComputedStyle(...).transform, state)`
// then `target = base + state`. Because `base` is invariant under ANY amount
// of paint lag (a transition only ever animates translate, never resizes the
// box) and `target` is derived from `state` — the same accumulator every
// panBy call mutates synchronously, regardless of what has or hasn't
// painted — the clamp is now correct even while animating. This test proves
// exactly that: it drives `panBy` with `animate: true` under a WORST-CASE
// stuck paint (the rect and computed style never move at all, simulating a
// transition that never advances past frame zero) and asserts the clamp
// still holds. Unlike the old `stubOversizedGeometry`-style frozen rect used
// elsewhere in this file (which never exercises repeated calls meaningfully
// since each call is independent), holding the rect frozen ACROSS 50 calls
// here is deliberate — it is the specific condition that broke the old,
// rect-based clamp (see the falsification note below).
// ---------------------------------------------------------------------------
describe("attachPanZoom.panBy — target-based clamp survives paint lag (v0.9.19 fix for the v0.9.18 burst-overshoot bug)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    panZoomSetting.set("on");
  });

  /** Freeze BOTH `getBoundingClientRect()` and `getComputedStyle(svg).transform`
   *  at the content's untransformed resting position, no matter how many
   *  `panBy` calls have already landed — as if the paint were permanently
   *  stuck (the worst case of "lag"). The computed style reports a matrix
   *  whose tx/ty are exactly {0, 0}, consistent with the frozen rect (a
   *  rendered translate of {0,0} IS what that rect would look like) — so
   *  `renderedTranslate` parses it successfully (not the jsdom-fallback
   *  path) and the fix's `base = rect − rendered` math is genuinely
   *  exercised, not accidentally bypassed.
   *
   *  FALSIFICATION NOTE (verified manually, see the frontend-engineer report):
   *  reverting `panBy` to clamp directly against `contentRect` (the OLD,
   *  v0.9.18-era code) makes this test fail — the frozen rect reports the
   *  SAME "150px of slack" on every one of the 50 calls (it never reflects
   *  any prior write), so the old clamp approves every -90 delta in full and
   *  `state`/the final transform overshoots to -4500 instead of clamping at
   *  -150. */
  function stubStuckPaint(host: HTMLElement, svg: SVGElement): void {
    (host as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    (svg as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () =>
      ({ left: -150, top: -150, right: 250, bottom: 250, width: 400, height: 400 }) as DOMRect;
    const realGetComputedStyle = globalThis.getComputedStyle;
    vi.stubGlobal("getComputedStyle", (el: Element, pseudoElt?: string | null) => {
      if (el === svg) return { transform: "matrix(1, 0, 0, 1, 0, 0)" } as CSSStyleDeclaration;
      return realGetComputedStyle(el, pseudoElt ?? undefined);
    });
  }

  it("holding a PageDown-equivalent panBy(0, -90, { animate: true }) for 50 rapid repeats never overshoots the boundary, even though the paint is permanently stuck at frame zero", () => {
    panZoomSetting.set("on");
    const { host, svg } = fakeHostAndSvg();
    stubStuckPaint(host, svg);
    const pz = attachPanZoom(host, svg);

    for (let i = 0; i < 50; i++) pz.panBy(0, -90, { animate: true });

    // max backward slack on Y = content.bottom(250) − host.bottom(100) = 150.
    // `svg.style.transform` always reflects `state` (the target) directly —
    // updateTransform writes it synchronously regardless of the `animate`
    // flag, which only toggles the `transition` CSS property.
    expect(svg.style.transform).toContain("translate(0px, -150px)");
    pz.destroy();
  });
});
