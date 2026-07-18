import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The HWP viewer (_workspace/01_hwp_viewer.md §8 F-2/F-3) — jsdom shape
// cloned from tests/html-viewer.test.ts (the closest prior art: a built-in-
// style viewer test that mocks @tauri-apps/api/core and mounts through the
// shared openViewerShell). jsdom has no IntersectionObserver, so
// hwp-viewer.ts's observePages() falls back to eagerly rendering every
// placeholder — the exact branch these tests exercise (design §8 F-3).
const invokeMock = vi.fn((cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "hwp_open") {
    const path = String(args?.path ?? "");
    if (path.endsWith("corrupt.hwp")) return Promise.reject(new Error("HWP 파일 파싱 오류: mock corrupt fixture"));
    return Promise.resolve({ pages: 3 });
  }
  if (cmd === "hwp_render_page") {
    const page = Number(args?.page ?? 0);
    // Page 1 carries the SAME adversarial payload the real browser mock's
    // mockHwpPageSvg does (G11, design §9) — a <script> tag AND an onload
    // probe — so T1 below proves the img-only DOM contract holds even when
    // the SVG source is hostile, not just when it's benign.
    const probe =
      page === 1
        ? `<script>window.__HWP_TEST_PWNED=1<\/script><rect width="1" height="1" onload="window.__HWP_TEST_PWNED_ONLOAD=1"/>`
        : "";
    return Promise.resolve(
      `<svg xmlns="http://www.w3.org/2000/svg" width="595" height="842">${probe}<text x="20" y="40">HWP-PAGE-${page}</text></svg>`,
    );
  }
  if (cmd === "hwp_close") return Promise.resolve(undefined);
  return Promise.resolve(undefined);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { registerHwpViewer } from "../src/chrome/viewer/hwp-viewer";
import { viewerFor } from "../src/chrome/viewer/registry";
import { fontScaleSetting } from "../src/settings/app";

// Registered ONCE for the whole file (registerViewer throws on a duplicate
// id) — every test looks the already-registered viewer up via viewerFor,
// same convention tests/html-viewer.test.ts uses.
registerHwpViewer();

let editorHost: HTMLElement;

beforeEach(() => {
  editorHost = document.createElement("div");
  editorHost.className = "editor-host";
  document.body.append(editorHost);
  invokeMock.mockClear();
  (window as unknown as Record<string, unknown>).__HWP_TEST_PWNED = undefined;
  (window as unknown as Record<string, unknown>).__HWP_TEST_PWNED_ONLOAD = undefined;
});
afterEach(() => {
  editorHost.remove();
  document.querySelector(".viewer-backdrop")?.remove();
  fontScaleSetting.set(1.0); // reset SSOT between tests (localStorage-backed singleton)
});

/** Drain the open()'s async chain: the outer IIFE's `await hwp_open`, then
 *  the eager-render fallback's per-page `invoke("hwp_render_page").then(...)`
 *  — each a separate microtask hop. A few macrotask ticks are enough for all
 *  of them to settle regardless of exact hop count. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe("registerHwpViewer registry shape (T2)", () => {
  it("registers id hwp for hwp/hwpx — lowercase, no leading dot", () => {
    const v = viewerFor("hwp");
    expect(v?.id).toBe("hwp");
    expect(v?.extensions).toEqual(["hwp", "hwpx"]);
    expect(viewerFor("hwpx")?.id).toBe("hwp");
  });
});

describe("openHwpViewer: placeholder count + img-only security contract (T1/T3 — the heart of this design)", () => {
  it("creates one placeholder per reported page, and every rendered page becomes ONLY an <img data:...> — zero inline <svg>/<script> nodes", async () => {
    const v = viewerFor("hwp")!;
    const handle = v.open("/vault/sample.hwp");
    await flush();

    const pagesEl = document.querySelector(".hwp-viewer-pages") as HTMLElement;
    expect(pagesEl).toBeTruthy();
    expect(pagesEl.querySelectorAll(".hwp-viewer-page")).toHaveLength(3);

    await flush();

    const imgs = pagesEl.querySelectorAll("img.hwp-viewer-page-img");
    expect(imgs).toHaveLength(3);
    for (const img of Array.from(imgs)) {
      expect((img as HTMLImageElement).src.startsWith("data:image/svg+xml;base64,")).toBe(true);
    }

    // The heart of the security contract: no inline <svg> or <script> node
    // anywhere in the rendered pages container, even though page 1's SVG
    // source carried a <script> + onload probe.
    expect(pagesEl.querySelectorAll("svg")).toHaveLength(0);
    expect(pagesEl.querySelectorAll("script")).toHaveLength(0);
    expect((window as unknown as Record<string, unknown>).__HWP_TEST_PWNED).toBeUndefined();
    expect((window as unknown as Record<string, unknown>).__HWP_TEST_PWNED_ONLOAD).toBeUndefined();

    handle.close();
  });
});

describe("openHwpViewer: close (T4)", () => {
  it("close() invokes hwp_close and is idempotent", async () => {
    const v = viewerFor("hwp")!;
    const handle = v.open("/vault/sample.hwp");
    await flush();
    handle.close();
    expect(invokeMock).toHaveBeenCalledWith("hwp_close", undefined);
    expect(() => handle.close()).not.toThrow();
  });

});

describe("openHwpViewer: corrupted file (T5)", () => {
  it("hwp_open rejection shows an error status and never throws", async () => {
    const v = viewerFor("hwp")!;
    const handle = v.open("/vault/corrupt.hwp");
    await flush();

    const status = document.querySelector(".hwp-viewer-status");
    expect(status?.textContent).toContain("문서를 열 수 없습니다");
    expect(document.querySelector(".hwp-viewer-pages")).toBeNull();

    handle.close();
  });
});

describe("openHwpViewer: page width is independent of editor fontScale (T6)", () => {
  // A document viewer fits the WHOLE page to the panel; it must NOT inherit the
  // editor's body-text zoom (fontScale) and render past the panel edge (사용자
  // 리포트 2026-07-18: "본문보다 2배 커보여, 컨텐츠가 다 안 보임"). 600px jsdom
  // fallback × 0.9 fraction = 540px, regardless of fontScale.
  it("width stays fit-to-panel (540px) no matter the fontScale on open or after a change", async () => {
    fontScaleSetting.set(1.5); // a zoomed editor must NOT inflate the page
    const v = viewerFor("hwp")!;
    const handle = v.open("/vault/sample.hwp");
    await flush();

    const pagesEl = document.querySelector(".hwp-viewer-pages") as HTMLElement;
    expect(pagesEl.style.getPropertyValue("--hwp-page-width")).toBe("540px"); // 600 × 0.9, NOT × 1.5

    fontScaleSetting.set(2.0); // change zoom while open → width must not move
    expect(pagesEl.style.getPropertyValue("--hwp-page-width")).toBe("540px");
    fontScaleSetting.set(0.8);
    expect(pagesEl.style.getPropertyValue("--hwp-page-width")).toBe("540px");

    handle.close();
  });
});

describe("openHwpViewer: viewer-local zoom, independent of fontScale (T8, design §B — adversarial pair)", () => {
  // Mirrors T6's "independent of fontScale" contract, but for the SHELL's
  // own zoom ladder instead — the full-pane rewrite's per-viewer zoom
  // (_workspace/01_architect_design.md §B): a page is a SVG-as-<img>
  // (vector), so scaling --hwp-page-width alone stays crisp at any factor,
  // no re-rasterization needed (unlike PDF's canvas). shell.zoom is the
  // SINGLE writer (the header's own −/+/label buttons); fontScaleSetting
  // must NEVER move this variable — the same decoupling T6 guards for the
  // editor's body-text zoom, now guarded a second, independent way.
  it("+ click scales --hwp-page-width to pageBaseWidth x factor; fontScaleSetting changes never touch it", async () => {
    const v = viewerFor("hwp")!;
    const handle = v.open("/vault/sample.hwp");
    await flush();

    const pagesEl = document.querySelector(".hwp-viewer-pages") as HTMLElement;
    expect(pagesEl.style.getPropertyValue("--hwp-page-width")).toBe("540px"); // 600 x 0.9 fallback, factor 1

    // POSITIVE half: the shell's own zoom-in button DOES scale the page width.
    const zoomIn = document.querySelector(".viewer-panel-zoom-in") as HTMLButtonElement;
    zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(pagesEl.style.getPropertyValue("--hwp-page-width")).toBe("594px"); // 540 x 1.1

    // NEGATIVE half (adversarial pair): fontScaleSetting changes must NEVER
    // touch this viewer's page width.
    fontScaleSetting.set(1.5);
    expect(pagesEl.style.getPropertyValue("--hwp-page-width")).toBe("594px");
    fontScaleSetting.set(0.8);
    expect(pagesEl.style.getPropertyValue("--hwp-page-width")).toBe("594px");

    handle.close();
  });
});

describe("openHwpViewer: render serialization (T7 — single-slot backend session race)", () => {
  // hwp.rs keeps the parsed document in a ONE-slot mutex that hwp_render_page
  // TAKES OUT for the whole render; two concurrent renders race and the second
  // fails "HWP 세션이 없습니다". The lazy observer fires for several pages at
  // once (in jsdom, the eager fallback fires ALL of them synchronously), so
  // the viewer must chain renders to one-in-flight. This guard goes RED on the
  // pre-fix code (which fired all three hwp_render_page calls immediately).
  it("requests page N+1 only after page N's render resolves (never concurrent)", async () => {
    const original = invokeMock.getMockImplementation()!;
    const resolvers: Array<(svg: string) => void> = [];
    const renderCalls: number[] = [];
    const svgFor = (p: number) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="595" height="842"><text x="20" y="40">P${p}</text></svg>`;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "hwp_render_page") {
        renderCalls.push(Number(args?.page ?? -1));
        return new Promise<string>((resolve) => resolvers.push(resolve));
      }
      return original(cmd, args);
    });

    const v = viewerFor("hwp")!;
    const handle = v.open("/vault/sample.hwp"); // mock reports 3 pages
    await flush();
    // Only page 0 requested; pages 1 & 2 wait behind it in the serial chain.
    expect(renderCalls).toEqual([0]);

    resolvers.shift()!(svgFor(0));
    await flush();
    expect(renderCalls).toEqual([0, 1]);

    resolvers.shift()!(svgFor(1));
    await flush();
    expect(renderCalls).toEqual([0, 1, 2]);

    resolvers.shift()!(svgFor(2));
    await flush();

    invokeMock.mockImplementation(original); // restore for other tests
    handle.close();
  });
});
