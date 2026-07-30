import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the Tauri core the same way tests/image.test.ts does: convertFileSrc
// is a pure prefix so the asset URL is observable in the DOM; invoke is a spy
// (unused here — the viewer never calls resolve_image, only resolveImageUrl).
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => "asset://" + p,
  invoke: vi.fn(),
}));

import { openImageViewer, wheelDeltaToPixels } from "../src/chrome/viewer/image-viewer";
import { panZoomSetting } from "../src/settings/app";

// ---------------------------------------------------------------------------
// Image viewer — an in-content pane (full-pane rewrite,
// _workspace/01_architect_design.md), sibling of `.editor-host` inside
// `.main-column`. No decorations, no CM measure tree involvement.
// ---------------------------------------------------------------------------

let editorHost: HTMLElement;

beforeEach(() => {
  editorHost = document.createElement("div");
  editorHost.className = "editor-host";
  document.body.append(editorHost);
  // The title-bar slots the viewer shell renders its filename + controls into
  // (chrome/title-bar.ts createTitleSlot/createViewerSlot) — the viewer has no
  // header row of its own since the 2026-07-19 title-bar integration.
  const docTitleSlot = document.createElement("div");
  docTitleSlot.className = "title-bar-doc-title";
  const viewerSlotFixture = document.createElement("div");
  viewerSlotFixture.className = "title-bar-viewer-slot";
  document.body.append(docTitleSlot, viewerSlotFixture);
});
afterEach(() => {
  document.querySelector(".viewer-panel")?.remove();
  editorHost.remove();
  document.querySelectorAll(".title-bar-doc-title, .title-bar-viewer-slot").forEach((n) => n.remove());
});

/** Fire onload after stamping natural* dimensions — jsdom never actually loads
 *  images, so the widths/heights are injected the way tests/image.test.ts
 *  injects onerror: call the handler directly. */
function fireLoad(img: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  img.onload?.(new Event("load"));
}
const fireError = (img: HTMLImageElement) => img.onerror?.(new Event("error"));

describe("openImageViewer: pane shape + image src", () => {
  it("mounts a pane (role=region) as .editor-host's sibling, with the asset URL and filename aria-label", () => {
    const handle = openImageViewer("/pics/cat.png");

    const pane = document.querySelector(".image-viewer.viewer-panel") as HTMLElement;
    expect(pane).toBeTruthy();
    expect(pane.getAttribute("role")).toBe("region");
    expect(pane.getAttribute("aria-label")).toBe("cat.png");
    expect(pane.hasAttribute("aria-modal")).toBe(false);
    expect(editorHost.hidden).toBe(true);
    expect(editorHost.hasAttribute("inert")).toBe(false);
    expect(editorHost.nextElementSibling).toBe(pane);

    const img = pane.querySelector("img") as HTMLImageElement;
    expect(img.src).toBe("asset:///pics/cat.png");

    handle.close();
  });

  it("caption shows the filename before load, then filename + naturalWidth×naturalHeight after onload", () => {
    const handle = openImageViewer("/pics/cat.png");
    const caption = document.querySelector(".image-viewer-caption") as HTMLElement;
    expect(caption.textContent).toBe("cat.png");

    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    fireLoad(img, 640, 480);
    expect(caption.textContent).toBe("cat.png — 640×480");

    handle.close();
  });

  it("onerror swaps the caption to a failure message and leaves the viewer open", () => {
    const handle = openImageViewer("/pics/broken.png");
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    fireError(img);

    const caption = document.querySelector(".image-viewer-caption") as HTMLElement;
    expect(caption.textContent).toBe("이미지를 불러올 수 없습니다");
    expect(document.querySelector(".viewer-panel")).toBeTruthy(); // still open

    handle.close();
  });
});

describe("openImageViewer: close paths (Esc / button / idempotent / focus)", () => {
  it("Escape removes the pane, restores .editor-host, and restores prior focus", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    openImageViewer("/pics/cat.png");
    expect(editorHost.hidden).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.querySelector(".viewer-panel")).toBeNull();
    expect(editorHost.hidden).toBe(false);
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });

  // ViewerHandle.onClose (2026-07-19): the OPENER must learn about closes it
  // never initiated, or chrome it changed on open stays stuck. main.ts relies
  // on exactly this to put the footer breadcrumb back on the live document's
  // folder after an Esc/✕ close ("브레드크럼프가 업데이트가 안되고있네").
  it("onClose fires for closes the opener never initiated (Esc, ✕) and for close(), exactly once", () => {
    // Esc — the case a caller-initiated-only signal would miss entirely.
    let escClosed = 0;
    openImageViewer("/pics/cat.png").onClose(() => (escClosed += 1));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(escClosed).toBe(1);

    // ✕ button.
    let xClosed = 0;
    openImageViewer("/pics/cat.png").onClose(() => (xClosed += 1));
    (document.querySelector(".image-viewer-close") as HTMLButtonElement).click();
    expect(xClosed).toBe(1);

    // Programmatic close(), and idempotent — a second close() must not re-fire.
    let apiClosed = 0;
    const handle = openImageViewer("/pics/cat.png");
    handle.onClose(() => (apiClosed += 1));
    handle.close();
    handle.close();
    expect(apiClosed).toBe(1);
  });

  it("the close button closes the pane", () => {
    const handle = openImageViewer("/pics/cat.png");
    const closeBtn = document.querySelector(".image-viewer-close") as HTMLButtonElement;
    closeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".viewer-panel")).toBeNull();
    handle.close();
  });

  it("close() is idempotent — calling it twice does not throw", () => {
    const handle = openImageViewer("/pics/cat.png");
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });

  it("focuses the pannable stage on open (so arrow/Page/wheel keys work immediately), not the close button", () => {
    // The shell focuses closeBtn first (accessibility default for every
    // viewer), but the image viewer moves focus onward to its stage so
    // keyboard panning is immediately usable without an extra Tab/click.
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    expect(document.activeElement).toBe(stage);
    handle.close();
  });
});

describe("openImageViewer: zoom (design §B/C — shell is the writer, applyImageZoom the sink)", () => {
  it("+ click scales the image's rendered width to naturalWidth × factor", () => {
    const handle = openImageViewer("/pics/cat.png");
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    fireLoad(img, 640, 480);

    const zoomIn = document.querySelector(".viewer-panel-zoom-in") as HTMLButtonElement;
    zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(img.style.width).toBe("704px"); // 640 * 1.1
    expect(img.style.maxWidth).toBe("none");

    handle.close();
  });

  it("resetting to 1.0 (label click) restores the fit CSS — no inline width/max-* left", () => {
    const handle = openImageViewer("/pics/cat.png");
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    fireLoad(img, 640, 480);

    const zoomIn = document.querySelector(".viewer-panel-zoom-in") as HTMLButtonElement;
    zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(img.style.width).not.toBe("");

    const zoomLabel = document.querySelector(".viewer-panel-zoom-label") as HTMLButtonElement;
    zoomLabel.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(img.style.width).toBe("");
    expect(img.style.maxWidth).toBe("");
    expect(img.style.maxHeight).toBe("");

    handle.close();
  });
});

describe("wheelDeltaToPixels (normalizes WheelEvent.deltaMode to CSS pixels)", () => {
  it("DOM_DELTA_PIXEL (0) passes the raw delta through unchanged", () => {
    expect(wheelDeltaToPixels(37, WheelEvent.DOM_DELTA_PIXEL, 500)).toBe(37);
    expect(wheelDeltaToPixels(-12.5, WheelEvent.DOM_DELTA_PIXEL, 500)).toBe(-12.5);
  });

  it("DOM_DELTA_LINE (1) scales by the line-height constant, not 1:1", () => {
    const oneLine = wheelDeltaToPixels(1, WheelEvent.DOM_DELTA_LINE, 500);
    expect(oneLine).toBeGreaterThan(1); // must NOT be treated as already-pixels
    expect(wheelDeltaToPixels(3, WheelEvent.DOM_DELTA_LINE, 500)).toBe(oneLine * 3);
  });

  it("DOM_DELTA_PAGE (2) scales by the given viewport size", () => {
    expect(wheelDeltaToPixels(1, WheelEvent.DOM_DELTA_PAGE, 500)).toBe(500);
    expect(wheelDeltaToPixels(2, WheelEvent.DOM_DELTA_PAGE, 300)).toBe(600);
  });
});

describe("openImageViewer: keyboard + wheel panning (no native scroll container — position is pure CSS transform)", () => {
  /** Stub the stage/img rects so the image is much bigger than the stage AND
   *  centered (150px of slack past the host's edge on every side) — jsdom
   *  never lays anything out, so every rect is 0×0 by default, which would
   *  make every pan clamp to 0 and hide real bugs. Centering (rather than
   *  flush-at-the-edge) matters here specifically so BOTH directions on each
   *  axis have room to move — an edge-flush stub would make one direction's
   *  assertions trivially 0 regardless of what panBy computed. */
  function stubOversizedGeometry(stage: HTMLElement, img: HTMLImageElement): void {
    Object.defineProperty(stage, "clientWidth", { value: 100, configurable: true });
    Object.defineProperty(stage, "clientHeight", { value: 100, configurable: true });
    (stage as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    (img as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () =>
      ({ left: -150, top: -150, right: 250, bottom: 250, width: 400, height: 400 }) as DOMRect;
  }

  beforeEach(() => panZoomSetting.set("on")); // panBy is a real no-op stub when "off"
  afterEach(() => panZoomSetting.set("on"));

  it("still pans when the MERMAID pan/zoom setting is off (the viewer forces it on)", () => {
    // Regression (2026-07-31): openImageViewer used to call attachPanZoom
    // without `force`, so `설정 › Mermaid › 팬/줌 → 끄기` silently removed the
    // image viewer's ONLY way to reach the rest of a zoomed image — drag, and
    // then keyboard/wheel scrolling too. A diagram preference must not decide
    // whether an image viewer can scroll; the fullscreen mermaid lightbox
    // passes `force` for the same reason. The other tests in this block pin
    // the setting "on", so without this one the coupling is invisible.
    panZoomSetting.set("off");
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubOversizedGeometry(stage, img);

    stage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(img.style.transform).toContain("translate(0px, -60px)");
    handle.close();
  });

  it("ArrowDown pans the transform so the image's LOWER part comes into view (translateY decreases)", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubOversizedGeometry(stage, img);

    stage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(img.style.transform).toContain("translate(0px, -60px)");
    handle.close();
  });

  it("ArrowUp pans the opposite way (translateY increases)", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubOversizedGeometry(stage, img);

    stage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    expect(img.style.transform).toContain("translate(0px, 60px)");
    handle.close();
  });

  it("PageDown pans by 90% of the stage's visible height, in the ArrowDown direction", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubOversizedGeometry(stage, img);

    stage.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));

    expect(img.style.transform).toContain("translate(0px, -90px)"); // 100 * 0.9
    handle.close();
  });

  it("End jumps to the maximum backward slack on Y (all the way down)", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubOversizedGeometry(stage, img);

    stage.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));

    // backward slack = content.bottom(250) - host.bottom(100) = 150
    expect(img.style.transform).toContain("translate(0px, -150px)");
    handle.close();
  });

  it("a keydown with a modifier (⌘/Ctrl/Alt) is ignored, so it doesn't fight app shortcuts like ⌘±", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubOversizedGeometry(stage, img);

    stage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", metaKey: true, bubbles: true }));

    expect(img.style.transform).toBe("");
    handle.close();
  });

  it("wheel (no modifier) pans in the same direction as ArrowDown for a downward scroll", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubOversizedGeometry(stage, img);

    stage.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 40, deltaMode: WheelEvent.DOM_DELTA_PIXEL, bubbles: true, cancelable: true }),
    );

    // wheel scroll down (deltaY > 0) → content moves up → translateY negative,
    // same sign as ArrowDown above.
    expect(img.style.transform).toContain("translate(0px, -40px)");
    handle.close();
  });

  it("a ctrl/⌘ wheel (zoom gesture / trackpad pinch) is left untouched by the pan handler", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubOversizedGeometry(stage, img);

    stage.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 40, ctrlKey: true, bubbles: true, cancelable: true }),
    );

    // the pan handler bailed; attachPanZoom's own onWheel (ctrl/meta = zoom)
    // took it instead, which does NOT touch translate for a deltaY-only wheel
    // (it changes scale). Transform stays untouched by panning.
    expect(img.style.transform).not.toContain("-40px");
    handle.close();
  });

  it("Escape still closes the viewer — the keydown handler does not swallow it", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubOversizedGeometry(stage, img);

    stage.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.querySelector(".viewer-panel")).toBeNull();
    handle.close(); // idempotent safety net
  });
});

// ---------------------------------------------------------------------------
// Regression: v0.9.18 real-app bug report — "held-down PageDown flies the
// image off-screen" / "trackpad wheel jitters". Root cause: `panBy` clamped
// against `getBoundingClientRect()` while ANIMATING the write
// (withTransition=true). Mid-transition, the painted rect lags behind
// `state`, so a fast burst of calls (key repeat, trackpad inertia) each
// see stale, over-generous slack and keep pushing `state` past the real
// boundary. Fix: `panBy` writes untransitioned (mermaid-widget.ts panBy,
// updateTransform(..., false)) so the rect the NEXT call reads back is
// exactly what the PREVIOUS call committed — no lag, no lag-driven overshoot.
//
// Two tests, deliberately split (mirrors tests/viewer-flex-item.test.ts's
// rule+premise structure):
//   (a) RULE — the clamp arithmetic holds under a rapid burst.
//   (b) PREMISE — panBy writes untransitioned, which is *why* (a) holds in
//       the real app. jsdom does not simulate CSS transitions, so (a) alone
//       cannot catch a reintroduced withTransition=true — it would keep
//       passing here while silently reproducing the exact bug in a real
//       browser. (b) is what actually locks the mechanism.
// ---------------------------------------------------------------------------
describe("openImageViewer: panBy burst-clamp regression (v0.9.18 — PageDown-held / trackpad-inertia flies the image off-screen)", () => {
  /** Parse the `translate(Xpx, Ypx)` this codebase's `updateTransform` writes
   *  (mermaid-widget.ts). Returns {0,0} before any pan has happened. */
  function currentTranslate(img: HTMLImageElement): { x: number; y: number } {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(img.style.transform);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
  }

  /** An HONEST fake geometry: unlike `stubOversizedGeometry` (a frozen rect),
   *  this one recomputes the img's rect from its CURRENT `style.transform`
   *  every time it's called — exactly what a real browser's
   *  `getBoundingClientRect()` does once a write has actually painted. A
   *  frozen stub can't reproduce this bug at all (the "remaining slack" it
   *  reports never changes no matter how far `state` has already gone), so
   *  the clamp regression can only be exercised against a rect that tracks
   *  the transform. Host stays fixed at 0,0..100,100; the untransformed
   *  image occupies -150,-150..250,250 (400×400, centered, 150px slack on
   *  every edge) — same fixture shape as `stubOversizedGeometry` above. */
  function stubHonestGeometry(stage: HTMLElement, img: HTMLImageElement): void {
    Object.defineProperty(stage, "clientWidth", { value: 100, configurable: true });
    Object.defineProperty(stage, "clientHeight", { value: 100, configurable: true });
    (stage as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    (img as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () => {
      const { x, y } = currentTranslate(img);
      const left = -150 + x;
      const top = -150 + y;
      return { left, top, right: left + 400, bottom: top + 400, width: 400, height: 400 } as DOMRect;
    };
  }

  it("(a) RULE: holding PageDown (50 rapid repeats) never pushes the content's edge past the host's edge", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubHonestGeometry(stage, img);

    for (let i = 0; i < 50; i++) {
      stage.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    }

    // max backward slack on Y = content.bottom(250) − host.bottom(100) = 150,
    // so translateY must settle at exactly −150 and never overshoot past it,
    // however many repeats land after the boundary is reached.
    const { y } = currentTranslate(img);
    expect(y).toBe(-150);

    // Equivalent boundary statement in rect terms: the content's bottom edge
    // must never end up ABOVE (numerically less than) the host's bottom edge
    // — that would mean the image scrolled fully past the host and off-screen.
    const finalRect = img.getBoundingClientRect();
    expect(finalRect.bottom).toBeGreaterThanOrEqual((stage.getBoundingClientRect() as DOMRect).bottom);

    handle.close();
  });

  it("(b) PREMISE: panBy writes the transform WITHOUT a CSS transition — jsdom can't simulate transitions, so this is the only test that would catch a reintroduced withTransition=true (test (a) would keep passing on the honest fake even though the real-app bug would be back)", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubHonestGeometry(stage, img);

    stage.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));

    expect(img.style.transition).toBe("");

    handle.close();
  });
});
