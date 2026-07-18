import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the Tauri core the same way tests/image.test.ts does: convertFileSrc
// is a pure prefix so the asset URL is observable in the DOM; invoke is a spy
// (unused here — the viewer never calls resolve_image, only resolveImageUrl).
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => "asset://" + p,
  invoke: vi.fn(),
}));

import { openImageViewer } from "../src/chrome/viewer/image-viewer";

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

  it("focuses the close button on open (accessibility)", () => {
    const handle = openImageViewer("/pics/cat.png");
    const closeBtn = document.querySelector(".image-viewer-close") as HTMLButtonElement;
    expect(document.activeElement).toBe(closeBtn);
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
