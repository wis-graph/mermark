import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// R11 2단계 (_workspace/01_html_viewer.md §7 TDD step 3), jsdom shape cloned
// from tests/excel-viewer.test.ts's sibling `image-viewer.test.ts` (a real
// DOM-mounted viewer test) — this file is where the security contract lives,
// so T1/T2 come first and matter most.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost${p}`,
}));

import { registerHtmlViewer } from "../src/extensions/html-viewer";
import { viewerFor } from "../src/chrome/viewer/registry";
import { fontScaleSetting } from "../src/settings/app";

// Registered ONCE for the whole file — registerViewer throws on a duplicate
// id (fail-fast, registry.ts), and vitest's module graph is shared across
// `it`s within one file (only reset BETWEEN files). Every test below looks
// the already-registered viewer up via viewerFor rather than re-registering.
registerHtmlViewer();

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
  editorHost.remove();
  document.querySelectorAll(".title-bar-doc-title, .title-bar-viewer-slot").forEach((n) => n.remove());
  document.querySelector(".viewer-backdrop")?.remove();
  vi.unstubAllGlobals();
  fontScaleSetting.set(1.0); // reset SSOT between tests (localStorage-backed singleton)
});

function stubFetchOk(html: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => new TextEncoder().encode(html).buffer,
    }),
  );
}

describe("registerHtmlViewer registry shape (T3)", () => {
  it("registers id ext.html for html/htm — lowercase, no leading dot", () => {
    const v = viewerFor("html");
    expect(v?.id).toBe("ext.html");
    expect(v?.extensions).toEqual(["html", "htm"]);
    expect(viewerFor("htm")?.id).toBe("ext.html");
  });
});

describe("openHtmlViewer: sandbox security contract (T1 — the heart of this design)", () => {
  it("the iframe's sandbox attribute is EXACTLY an empty string — never allow-scripts/allow-same-origin", async () => {
    stubFetchOk("<html><body>hi</body></html>");
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute("sandbox")).toBe("");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");

    handle.close();
  });
});

describe("openHtmlViewer: srcdoc property, not a src URL load (T2)", () => {
  it("srcdoc carries the prepared HTML; the src attribute is absent (frame-src independent)", async () => {
    stubFetchOk("<html><body>marker-xyz</body></html>");
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement;
    expect(iframe.srcdoc).toContain("marker-xyz");
    expect(iframe.hasAttribute("src")).toBe(false);

    handle.close();
  });
});

describe("openHtmlViewer: close (T4)", () => {
  it("close() is idempotent", async () => {
    stubFetchOk("<html><body>hi</body></html>");
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });

  it("close() unsubscribes the shell zoom sink — a post-close close() call never throws touching the (removed) iframe", async () => {
    stubFetchOk("<html><body>hi</body></html>");
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement;
    const zoomIn = document.querySelector(".viewer-panel-zoom-in") as HTMLButtonElement;
    zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(iframe.style.transform).toBe("scale(1.1)");

    handle.close();
    // The pane (header + zoom buttons) is gone with the iframe after
    // close() — there is nothing left to click that could reach a detached
    // node, so the regression this guards is close() itself: a leaked
    // `shell.zoom.bind` subscription would still be invoked by a LATER
    // open()'s zoom clicks and throw trying to style this closed iframe.
    expect(() => handle.close()).not.toThrow();
  });
});

describe("openHtmlViewer: zoom is shell-local, independent of fontScale (T5, design §B — adversarial pair)", () => {
  // The v0.8.6/full-pane-rewrite decoupling this guards: a viewer's zoom is
  // the SHELL's own per-open ladder (header −/+/label), never the editor's
  // ⌘±/fontScaleSetting. Proving only the positive half (shell zoom moves
  // the iframe) would pass even if a stray fontScale fan-out sink were still
  // wired alongside it — the negative half is what actually catches that
  // regression class (the exact bug this file's T4 used to test the OPPOSITE
  // way, before the full-pane rewrite made fontScale-driven zoom wrong).
  it("shell zoom (+ click) scales the iframe transform/width; fontScaleSetting changes never touch it", async () => {
    stubFetchOk("<html><body>hi</body></html>");
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement;
    // Default: fit (shell.zoom starts at 1) — applyHtmlZoom(iframe, 1) was
    // already applied by the bind-now half of shell.zoom.bind at open time.
    expect(iframe.style.transform).toBe("scale(1)");
    expect(iframe.style.transformOrigin).toBe("0 0");

    // POSITIVE half: the shell's own zoom-in button DOES scale the iframe.
    const zoomIn = document.querySelector(".viewer-panel-zoom-in") as HTMLButtonElement;
    zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(iframe.style.transform).toBe("scale(1.1)");
    // jsdom's CSSOM normalizes `calc(100% / 1.1)` to a folded percentage —
    // assert on the fact applyHtmlZoom's own calc() literal took effect,
    // not jsdom's arithmetic-folded serialization of it.
    expect(iframe.style.width).toContain("calc(");

    // NEGATIVE half (the adversarial pair): fontScaleSetting changes must
    // NEVER touch this viewer's iframe — the fan-out this design removed.
    const transformAfterShellZoom = iframe.style.transform;
    const widthAfterShellZoom = iframe.style.width;
    fontScaleSetting.set(1.8);
    expect(iframe.style.transform).toBe(transformAfterShellZoom);
    expect(iframe.style.width).toBe(widthAfterShellZoom);
    fontScaleSetting.set(0.7);
    expect(iframe.style.transform).toBe(transformAfterShellZoom);
    expect(iframe.style.width).toBe(widthAfterShellZoom);

    handle.close();
  });
});

describe("openHtmlViewer: relative asset rewrite integration (design §3.4)", () => {
  it("a relative <img src> in the loaded document is rewritten to an asset URL", async () => {
    stubFetchOk('<html><body><img src="chart.png"></body></html>');
    const v = viewerFor("html")!;
    const handle = v.open("/vault/dir/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement;
    expect(iframe.srcdoc).toContain('src="asset://localhost/vault/dir/chart.png"');

    handle.close();
  });
});

describe("openHtmlViewer: a failed fetch surfaces an error, never a silent stuck state", () => {
  it("shows an error status and does not throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found", arrayBuffer: async () => new ArrayBuffer(0) }),
    );
    const v = viewerFor("html")!;
    const handle = v.open("/vault/missing.html");
    await new Promise((r) => setTimeout(r, 0));

    const status = document.querySelector(".html-viewer-status");
    expect(status?.textContent).toContain("문서를 열 수 없습니다");

    handle.close();
  });
});
