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
});
afterEach(() => {
  editorHost.remove();
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

  it("close() unsubscribes the fontScale sink — a post-close zoom change no longer touches the (removed) iframe", async () => {
    stubFetchOk("<html><body>hi</body></html>");
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement;
    fontScaleSetting.set(1.3);
    expect(iframe.style.transform).toBe("scale(1.3)");

    handle.close();
    const transformAtClose = iframe.style.transform;
    fontScaleSetting.set(1.7); // would throw / mutate a detached node if the sink were still live
    expect(iframe.style.transform).toBe(transformAtClose); // unchanged — sink is gone
  });
});

describe("openHtmlViewer: zoom (T5, design §6)", () => {
  it("applyHtmlZoom reflects fontScaleSetting immediately on open, and on every change", async () => {
    fontScaleSetting.set(1.5);
    stubFetchOk("<html><body>hi</body></html>");
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement;
    expect(iframe.style.transform).toBe("scale(1.5)");
    // jsdom's CSSOM normalizes `calc(100% / 1.5)` to a folded percentage —
    // assert on the SOURCE rule mermark sets (applyHtmlZoom's own literal),
    // not jsdom's arithmetic-folded serialization of it.
    expect(iframe.style.width).toContain("calc(");
    expect(iframe.style.transformOrigin).toBe("0 0");

    fontScaleSetting.set(0.8);
    expect(iframe.style.transform).toBe("scale(0.8)");

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
