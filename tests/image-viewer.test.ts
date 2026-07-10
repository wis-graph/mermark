import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the Tauri core the same way tests/image.test.ts does: convertFileSrc
// is a pure prefix so the asset URL is observable in the DOM; invoke is a spy
// (unused here — the viewer never calls resolve_image, only resolveImageUrl).
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => "asset://" + p,
  invoke: vi.fn(),
}));

import { openImageViewer } from "../src/viewer/image-viewer";

// ---------------------------------------------------------------------------
// Image viewer — a body-level lightbox overlay for explorer image clicks,
// structurally identical to the conflict modal (backdrop/dialog/Esc/inert/
// focus-restore). No decorations, no CM measure tree involvement.
// ---------------------------------------------------------------------------

let editorHost: HTMLElement;

beforeEach(() => {
  editorHost = document.createElement("div");
  editorHost.className = "editor-host";
  document.body.append(editorHost);
});
afterEach(() => {
  editorHost.remove();
  document.querySelector(".viewer-backdrop")?.remove();
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

describe("openImageViewer: overlay shape + image src", () => {
  it("mounts a backdrop + role=dialog with the asset URL and filename aria-label", () => {
    const handle = openImageViewer("/pics/cat.png");

    const backdrop = document.querySelector(".viewer-backdrop") as HTMLElement;
    expect(backdrop).toBeTruthy();
    const dialog = backdrop.querySelector('.image-viewer[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("cat.png");

    const img = dialog.querySelector("img") as HTMLImageElement;
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
    expect(document.querySelector(".viewer-backdrop")).toBeTruthy(); // still open

    handle.close();
  });
});

describe("openImageViewer: close paths (Esc / backdrop / button)", () => {
  it("Escape removes the overlay, clears .editor-host inert, and restores prior focus", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    openImageViewer("/pics/cat.png");
    expect(editorHost.hasAttribute("inert")).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.querySelector(".viewer-backdrop")).toBeNull();
    expect(editorHost.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });

  it("backdrop click closes; a click inside the dialog does not", () => {
    const handle = openImageViewer("/pics/cat.png");
    const backdrop = document.querySelector(".viewer-backdrop") as HTMLElement;
    const dialog = backdrop.querySelector(".image-viewer") as HTMLElement;

    dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".viewer-backdrop")).toBeTruthy(); // still open

    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".viewer-backdrop")).toBeNull();

    handle.close(); // idempotent no-op — already closed
  });

  it("the close button closes the overlay", () => {
    const handle = openImageViewer("/pics/cat.png");
    const closeBtn = document.querySelector(".image-viewer-close") as HTMLButtonElement;
    closeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".viewer-backdrop")).toBeNull();
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
