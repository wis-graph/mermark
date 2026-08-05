import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the Tauri core the same way tests/image.test.ts does: convertFileSrc
// is a pure prefix so the asset URL is observable in the DOM; invoke is a spy
// (unused here — the viewer never calls resolve_image, only resolveImageUrl).
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => "asset://" + p,
  invoke: vi.fn(),
}));

import {
  openImageViewer,
  wheelDeltaToPixels,
  panIndicatorFor,
  imageDisplayName,
  imageViewerUrl,
} from "../src/chrome/viewer/image-viewer";
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

describe("imageDisplayName (_workspace/01_architect_design_imgclick.md판정5)", () => {
  it("local absolute path → basename", () => {
    expect(imageDisplayName("/a/b/pic.png")).toBe("pic.png");
  });
  it("remote URL → last path segment, query stripped", () => {
    expect(imageDisplayName("https://ex.com/img/cat.png?w=2")).toBe("cat.png");
  });
  it("remote URL with an empty pathname falls back to the hostname", () => {
    expect(imageDisplayName("https://ex.com")).toBe("ex.com");
  });
  it("data: URL has no filename — a fixed placeholder", () => {
    expect(imageDisplayName("data:image/png;base64,AAAA")).toBe("이미지");
  });

  // Regression (04_audit_report_imgclick.md 🟡①): `isRemoteSrc` only checks
  // the `https?://` prefix, not well-formedness, so a degenerate target like
  // `![](https://)` still passes it but makes `new URL` throw. Before this
  // fix that throw propagated out of `openImageViewer`'s first line, AFTER
  // `placeInViewerSlot` had already closed the previous viewer but BEFORE it
  // stored the new handle — a stale slot. imageDisplayName must be total.
  it("a malformed remote URL (fails new URL()) falls back to the placeholder instead of throwing", () => {
    expect(() => imageDisplayName("https://")).not.toThrow();
    expect(imageDisplayName("https://")).toBe("이미지");
  });
});

describe("imageViewerUrl (never re-resolves a remote/data source)", () => {
  it("passes a remote URL through unchanged (no convertFileSrc prefix)", () => {
    expect(imageViewerUrl("https://ex.com/cat.png")).toBe("https://ex.com/cat.png");
  });
  it("passes a data: URL through unchanged", () => {
    expect(imageViewerUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });
  it("a local absolute path resolves the same way resolveImageUrl(source, dirOf(source)) would", () => {
    expect(imageViewerUrl("/pics/cat.png")).toBe("asset:///pics/cat.png");
  });
});

describe("openImageViewer: degenerate remote source (regression — must not throw mid-open)", () => {
  it("opens without throwing and shows the placeholder caption for a malformed remote target", () => {
    const handle = openImageViewer("https://");
    expect(document.querySelector(".viewer-panel")).toBeTruthy();
    const caption = document.querySelector(".image-viewer-caption") as HTMLElement;
    expect(caption.textContent).toBe("이미지");
    handle.close();
  });
});

describe("openImageViewer: remote source (editor image click → viewer, no local resolve)", () => {
  it("mounts with the remote URL as-is and a caption derived from the URL's last path segment", () => {
    const handle = openImageViewer("https://ex.com/img/cat.png?w=2");
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    expect(img.src).toBe("https://ex.com/img/cat.png?w=2");
    const caption = document.querySelector(".image-viewer-caption") as HTMLElement;
    expect(caption.textContent).toBe("cat.png");
    handle.close();
  });
});

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
// image off-screen" / "trackpad wheel jitters".
//
// v0.9.18 fix (superseded): banned animation on `panBy` outright
// (withTransition always false) — a source-level premise standing in for a
// real fix, since the actual defect was that the clamp read the PAINTED rect
// instead of the content's TARGET position.
//
// v0.9.19 fix: `panBy` now clamps against the content's TARGET box
// (`renderedTranslate` + `base = rect − rendered`, `target = base + state` —
// see mermaid-widget.ts), which is correct regardless of how far a CSS
// transition has animated. The falsification-capable version of this
// regression guard (one that actually drives paint LAG under `animate: true`
// and proves the old rect-based clamp would have overshot) now lives in
// tests/mermaid-widget.test.ts, next to `panBy`/`renderedTranslate`
// themselves — `getComputedStyle` stubbing needs full control over a single
// bare svg/host pair, which is awkward through `openImageViewer`'s DOM.
//
// What stays here, at the image-viewer level:
//   (a) An end-to-end sanity check — the clamp still holds when driven
//       through the real keydown handler (not just the unit-level pz.panBy).
//   (b) A visible-BEHAVIOR-PARITY check: image-viewer.ts's call sites all
//       still omit `opts` (→ `animate` defaults to false), so nothing here
//       is user-visibly different from v0.9.19 — this is deliberate for now
//       (see coordinator note in mermaid-widget.ts's panBy comment: which
//       inputs get `animate: true` is an open UX decision, not shipped yet).
//       This test exists to catch an ACCIDENTAL animate flip, not to assert
//       a permanent contract — expect it to need updating once that UX
//       decision lands.
// ---------------------------------------------------------------------------
describe("openImageViewer: panBy burst-clamp regression (v0.9.18 — PageDown-held / trackpad-inertia flies the image off-screen)", () => {
  /** Parse the `translate(Xpx, Ypx)` this codebase's `updateTransform` writes
   *  (mermaid-widget.ts). Returns {0,0} before any pan has happened. */
  function currentTranslate(img: HTMLImageElement): { x: number; y: number } {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(img.style.transform);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
  }

  /** A geometry fake that recomputes the img's rect from its CURRENT
   *  `style.transform` on every read — i.e. it assumes the paint has
   *  instantly caught up to `state` (no lag). That's exactly true for
   *  image-viewer's current call sites (all `animate: false`), so this is
   *  the right fake for an end-to-end "does the visible path still clamp"
   *  check — it is NOT the fake that would catch a paint-lag regression
   *  (see tests/mermaid-widget.test.ts's `stubStuckPaint` for that one).
   *  Host stays fixed at 0,0..100,100; the untransformed image occupies
   *  -150,-150..250,250 (400×400, centered, 150px slack on every edge). */
  function stubInstantGeometry(stage: HTMLElement, img: HTMLImageElement): void {
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

  it("(a) end-to-end: holding PageDown (50 rapid repeats) never pushes the content's edge past the host's edge", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubInstantGeometry(stage, img);

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

  it("(b) visible-behavior parity: every panning input (wheel, arrow, Page, Home/End) still writes the transform WITHOUT a CSS transition — no animate mapping has shipped yet, so v0.9.19 must look identical to v0.9.19-pre-refactor to the user", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubInstantGeometry(stage, img);

    for (const key of ["ArrowDown", "PageDown", "End"]) {
      stage.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      expect(img.style.transition).toBe("");
    }
    stage.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true }));
    expect(img.style.transition).toBe("");

    handle.close();
  });
});

describe("panIndicatorFor (position-indicator geometry: same arithmetic as a native scrollbar thumb)", () => {
  it("returns null when the content does not overflow the host (fits exactly)", () => {
    expect(panIndicatorFor({ start: 0, end: 100 }, { start: 0, end: 100 })).toBeNull();
  });

  it("returns null when the content is SMALLER than the host", () => {
    expect(panIndicatorFor({ start: 0, end: 60 }, { start: 0, end: 100 })).toBeNull();
  });

  it("sizeRatio is host/content — 2× overflow gives a half-length thumb", () => {
    // content 200 wide, host 100 wide, flush at the start.
    expect(panIndicatorFor({ start: 0, end: 200 }, { start: 0, end: 100 })).toEqual({
      sizeRatio: 0.5,
      startRatio: 0,
    });
  });

  it("startRatio is 0 at the very top/left (content flush with host's start)", () => {
    expect(panIndicatorFor({ start: 0, end: 300 }, { start: 0, end: 100 })!.startRatio).toBe(0);
  });

  it("startRatio is close to 1 at the very bottom/right (content flush with host's end)", () => {
    // content 300 long, host 100 long, content's end flush with host's end →
    // content.start = host.end − contentLen = 100 − 300 = −200.
    const geo = panIndicatorFor({ start: -200, end: 100 }, { start: 0, end: 100 });
    expect(geo!.startRatio).toBeCloseTo(200 / 300, 6);
  });

  it("clamps startRatio to [0,1] when the content sits outside the host's edges (unclamped drag mid-motion)", () => {
    // content.start > host.start (dragged so far right the content's left
    // edge has moved PAST the host's left edge) → raw startRatio would be
    // negative; clamps to 0.
    const overDraggedRight = panIndicatorFor({ start: 50, end: 350 }, { start: 0, end: 100 });
    expect(overDraggedRight!.startRatio).toBe(0);

    // content.end < host.end (dragged so far left the content's right edge
    // has moved BEFORE the host's right edge) → raw startRatio would exceed
    // 1 ((host.start − content.start)/contentLen with content.start very
    // negative); clamps to 1.
    const overDraggedLeft = panIndicatorFor({ start: -400, end: -100 }, { start: 0, end: 100 });
    expect(overDraggedLeft!.startRatio).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Position indicators (v0.9.19): this viewer has no native scroll container
// (position is pure CSS transform), so there is no scrollbar to tell the
// user "how much more is there, and where am I". These read-only overlay
// bars are the substitute — see image-viewer.ts's `refreshPanIndicators` doc
// for the "one recompute point, four triggers" design.
//
// The DRAG test below is the load-bearing one: `attachPanZoom`'s drag path
// does NOT go through `panBy` (it mutates `state` directly from the cursor's
// absolute position), so it's the one gesture most likely to be forgotten if
// someone later "simplifies" the `onTransform` wiring back down to just
// `panBy`. This is deliberately verified with falsification (see the
// frontend-engineer report): temporarily bypassing `commit()` in
// `attachPanZoom`'s drag-specific `onMouseUp` (calling `updateTransform`
// directly, same as the pre-`onTransform` code) makes ONLY this drag test
// fail — PageDown and the others stay green — which is exactly why a single
// "does SOME indicator test pass" check would not have been enough.
// ---------------------------------------------------------------------------
describe("openImageViewer: pan position indicators", () => {
  /** Geometry fake whose img rect FOLLOWS the current `style.transform` —
   *  required here (unlike the frozen `stubOversizedGeometry`/
   *  `stubInstantGeometry` fakes elsewhere in this file) because these tests
   *  assert the indicator's RATIO actually changes as the content moves;
   *  a frozen rect would report the same ratio forever regardless of how
   *  much panning happened, hiding exactly the bug this file is guarding.
   *  Untransformed base: -150,-150..250,250 (400×400, centered over a
   *  0,0..100,100 host — 150px of slack on every edge), same fixture shape
   *  used throughout this file. */
  function stubTransformFollowingGeometry(stage: HTMLElement, img: HTMLImageElement): void {
    Object.defineProperty(stage, "clientWidth", { value: 100, configurable: true });
    Object.defineProperty(stage, "clientHeight", { value: 100, configurable: true });
    (stage as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    (img as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () => {
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(img.style.transform);
      const x = m ? Number(m[1]) : 0;
      const y = m ? Number(m[2]) : 0;
      const left = -150 + x;
      const top = -150 + y;
      return { left, top, right: left + 400, bottom: top + 400, width: 400, height: 400 } as DOMRect;
    };
  }

  /** Content exactly fills the host on both axes — nothing overflows. */
  function stubFittingGeometry(stage: HTMLElement, img: HTMLImageElement): void {
    Object.defineProperty(stage, "clientWidth", { value: 100, configurable: true });
    Object.defineProperty(stage, "clientHeight", { value: 100, configurable: true });
    const rect = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } as DOMRect;
    (stage as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () => rect;
    (img as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = () => rect;
  }

  it("an image that fits the stage shows neither indicator", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubFittingGeometry(stage, img);

    fireLoad(img, 100, 100); // triggers refreshPanIndicators via onload

    const vTrack = document.querySelector(".image-viewer-pan-indicator-v") as HTMLElement;
    const hTrack = document.querySelector(".image-viewer-pan-indicator-h") as HTMLElement;
    expect(vTrack.hidden).toBe(true);
    expect(hTrack.hidden).toBe(true);

    handle.close();
  });

  it("an overflowing image shows both indicators once loaded", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubTransformFollowingGeometry(stage, img);

    fireLoad(img, 400, 400);

    const vTrack = document.querySelector(".image-viewer-pan-indicator-v") as HTMLElement;
    const hTrack = document.querySelector(".image-viewer-pan-indicator-h") as HTMLElement;
    expect(vTrack.hidden).toBe(false);
    expect(hTrack.hidden).toBe(false);

    handle.close();
  });

  it("PageDown moves the vertical indicator's thumb further down its track (startRatio increases)", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubTransformFollowingGeometry(stage, img);
    fireLoad(img, 400, 400);

    const vBar = document.querySelector(".image-viewer-pan-indicator-v .image-viewer-pan-indicator-bar") as HTMLElement;
    const before = Number.parseFloat(vBar.style.top); // 150/400 = 37.5% at rest

    stage.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));

    const after = Number.parseFloat(vBar.style.top);
    expect(after).toBeGreaterThan(before);

    handle.close();
  });

  it("dragging the image ALSO updates the indicators — proves onTransform fires for drag, not only for panBy-driven input", () => {
    const handle = openImageViewer("/pics/cat.png");
    const stage = document.querySelector(".image-viewer-stage") as HTMLElement;
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    stubTransformFollowingGeometry(stage, img);
    fireLoad(img, 400, 400);

    const vBar = document.querySelector(".image-viewer-pan-indicator-v .image-viewer-pan-indicator-bar") as HTMLElement;
    const before = vBar.style.top;

    stage.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: -80, clientY: -80 }));
    window.dispatchEvent(new MouseEvent("mouseup", {}));

    expect(vBar.style.top).not.toBe(before);

    handle.close();
  });
});
