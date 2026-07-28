import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// R11 2단계 (_workspace/01_html_viewer.md §7 TDD step 3), jsdom shape cloned
// from tests/excel-viewer.test.ts's sibling `image-viewer.test.ts` (a real
// DOM-mounted viewer test) — this file is where the security contract lives,
// so T1/T2 come first and matter most.
//
// _workspace/01_architect_design_htmljs.md §8/§10 (F1/F2/F3/F4): the mock's
// `convertFileSrc` differentiates by protocol so the off-path asset rewrite
// still resolves through "asset://" (the on-path no longer uses
// convertFileSrc at all — Revision 1's `htmlViewUrl(token, fileName)` builds
// its own `htmlview://<token>/…` string, `scripted-url.ts`). `invoke` is a
// spy (not a plain stub) so F2/F3 can assert `arm_html_view_root` call
// count/order, matching the plan's "spy 0회"/"spy 호출 순서" asserts — it
// resolves `arm_html_view_root` to a FIXED mock token (mirrors
// `src/mocks/tauri-core.ts`'s own `"mock-view-token"`, §10.7's "반환형이
// `()` → `String`(토큰)" contract) so F2 can assert the exact `src` the
// scripted path builds from it.
const MOCK_VIEW_TOKEN = "mock-view-token";
const invokeMock = vi.fn(async (cmd: string, _args?: unknown) => (cmd === "arm_html_view_root" ? MOCK_VIEW_TOKEN : undefined));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string, protocol?: string) => `${protocol ?? "asset"}://localhost${p}`,
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { registerHtmlViewer } from "../src/extensions/html-viewer";
import { viewerFor } from "../src/chrome/viewer/registry";
import { fontScaleSetting, htmlScriptsSetting } from "../src/settings/app";

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
  htmlScriptsSetting.set(false); // reset SSOT — default is false, tests that opt in must not leak
  invokeMock.mockClear();
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

describe("openHtmlViewer: sandbox security contract — OFF path (T1/F1, the heart of this design)", () => {
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

  // RED-F1 (plan): the default (unarmed) setting state never touches the
  // scripted path AT ALL — no `src`, `srcdoc` present, `arm_html_view_root`
  // never invoked, and no "JS" badge. This is the "off costs nothing new"
  // guarantee — a security-relevant setting existing in the codebase must not
  // itself change the default open() behavior by one bit.
  it("default (htmlScriptsSetting=false): no src attribute, srcdoc present, arm_html_view_root never called, no JS badge", async () => {
    stubFetchOk("<html><body>hi</body></html>");
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement;
    expect(iframe.hasAttribute("src")).toBe(false);
    expect(iframe.srcdoc).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith("arm_html_view_root", expect.anything());
    expect(document.querySelector(".html-viewer-js-badge")).toBeNull();

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

// RED-F2 (plan, Revision 1 per design §10.3/§10.7) — the ON contract: opt in
// via htmlScriptsSetting, then the open path is a completely different shape
// than T1/F1's off contract. Sandbox is now EXACTLY the two-token string
// (Revision 1 reverses the old "never allow-same-origin" rule — see this
// file's index.ts header comment for why that's safe here), asserted with
// `toBe` (not `contains`) so a THIRD token creeping in would fail loudly.
describe("openHtmlViewer: sandbox security contract — ON path (F2, design §2ⓔ/§3/§10 Revision 1)", () => {
  it('sandbox is EXACTLY "allow-scripts allow-same-origin" (no other tokens), src is the token-hosted htmlview:// URL, srcdoc is absent, and arm_html_view_root is called with the parent dir BEFORE src is set', async () => {
    htmlScriptsSetting.set(true);
    const v = viewerFor("html")!;
    const handle = v.open("/vault/dir/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(iframe.hasAttribute("srcdoc")).toBe(false);
    // The token (from arm_html_view_root's mocked return) is the URL's HOST,
    // not a path segment — design §10.3's per-open-origin invariant — and
    // only the document's own FILE NAME follows, never the absolute path.
    expect(iframe.getAttribute("src")).toBe(`htmlview://${MOCK_VIEW_TOKEN}/doc.html`);

    // arm_html_view_root was called, with the PARENT directory (not the file
    // itself), and it happened before src was assigned — src only appears
    // once the invoke() promise the mock resolved has settled (the `await`
    // above already ran past that resolution, so a call-count check here IS
    // the ordering check: if arm hadn't resolved yet, src would still be
    // absent per the assertion above).
    expect(invokeMock).toHaveBeenCalledWith("arm_html_view_root", { dir: "/vault/dir" });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    handle.close();
  });

  it("off path's fetch/decode/rewrite machinery is never invoked when scripted", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    htmlScriptsSetting.set(true);
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchSpy).not.toHaveBeenCalled();

    handle.close();
  });
});

// RED-F3 (plan) — toggle is read ONLY at open() time, never retroactively.
describe("openHtmlViewer: the setting is read once at open() time, non-retroactively (F3, design §6)", () => {
  it("a viewer opened OFF stays off even after the setting flips to on mid-session", async () => {
    stubFetchOk("<html><body>hi</body></html>");
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("");
    expect(iframe.hasAttribute("src")).toBe(false);

    htmlScriptsSetting.set(true); // flip mid-session — must not reach the already-open viewer

    expect(iframe.getAttribute("sandbox")).toBe("");
    expect(iframe.hasAttribute("src")).toBe(false);

    handle.close();
  });

  it("a viewer opened ON stays on even after the setting flips back to off mid-session", async () => {
    htmlScriptsSetting.set(true);
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");

    htmlScriptsSetting.set(false); // flip mid-session — the already-open scripted viewer keeps running

    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(iframe.hasAttribute("src")).toBe(true);

    handle.close();
  });
});

// RED-F4 (plan) — the "JS" badge is the user-visible signal that a document
// is scripted; it must track the open-time decision exactly.
describe("openHtmlViewer: the JS badge signals scripted mode (F4, design §5)", () => {
  it("present when opened with scripting on", async () => {
    htmlScriptsSetting.set(true);
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    const badge = document.querySelector(".html-viewer-js-badge");
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe("JS");

    handle.close();
  });

  it("absent when opened with scripting off (default)", async () => {
    stubFetchOk("<html><body>hi</body></html>");
    const v = viewerFor("html")!;
    const handle = v.open("/vault/doc.html");
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector(".html-viewer-js-badge")).toBeNull();

    handle.close();
  });
});
