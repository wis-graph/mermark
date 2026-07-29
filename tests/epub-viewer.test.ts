import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// EPUB viewer (_workspace/01_architect_plan_epub.md Stage F3) — jsdom shape
// cloned from tests/hwp-viewer.test.ts: mock @tauri-apps/api/core, mount
// through the shared openViewerShell, and jsdom's lack of
// IntersectionObserver exercises the eager-render fallback branch.

const CONTAINER_XML = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF_XML = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`;

const NAV_XHTML = `<!DOCTYPE html>
<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <nav epub:type="toc"><ol>
    <li><a href="text/ch1.xhtml">Chapter 1</a></li>
    <li><a href="text/ch2.xhtml">Chapter 2</a></li>
  </ol></nav>
</body></html>`;

const ENCRYPTION_XML_DRM = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/></EncryptedData>
</encryption>`;

// A book that declares a dc:identifier — for reading-position key tests
// (design_epub_position.md §2: identifier-keyed books share/survive moves,
// path-keyed ones (OPF_XML above has none) don't).
const OPF_XML_WITH_ID = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:isbn:test-book</dc:identifier></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`;

function fixtureInvoke(bookId: string) {
  return (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "arm_epub_view") {
      const path = String(args?.path ?? "");
      if (path.endsWith("bad.epub")) return Promise.reject(new Error("EPUB 파일을 열 수 없습니다"));
      // The backend's real not-a-zip rejection is the EXACT bare literal
      // "not-zip" (_workspace/02_backend_changes_epub.md) — armErrorMessage
      // (epub-viewer.ts) maps this through epubOpenErrorMessage("not-zip").
      if (path.endsWith("notzip.epub")) return Promise.reject("not-zip");
      return Promise.resolve(`token-${bookId}`);
    }
    if (cmd === "read_epub_entry") {
      const entry = String(args?.entry ?? "");
      if (entry === "META-INF/container.xml") {
        if (bookId === "no-container") return Promise.reject(new Error("entry not found: META-INF/container.xml"));
        return Promise.resolve(CONTAINER_XML);
      }
      if (entry === "OEBPS/content.opf") {
        if (bookId === "no-opf") return Promise.reject(new Error("entry not found: OEBPS/content.opf"));
        return Promise.resolve(bookId === "with-id" ? OPF_XML_WITH_ID : OPF_XML);
      }
      if (entry === "OEBPS/nav.xhtml") return Promise.resolve(NAV_XHTML);
      if (entry === "META-INF/encryption.xml") {
        if (bookId === "drm") return Promise.resolve(ENCRYPTION_XML_DRM);
        return Promise.reject(new Error("not found"));
      }
      return Promise.reject(new Error(`unknown entry: ${entry}`));
    }
    return Promise.resolve(undefined);
  };
}

const invokeMock = vi.fn(fixtureInvoke("normal"));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { registerEpubViewer, epubViewUrl } from "../src/chrome/viewer/epub-viewer";
import { viewerFor } from "../src/chrome/viewer/registry";
import { epubPositionsSetting } from "../src/settings/app";
import type { EpubReadingPosition } from "../src/chrome/viewer/epub-position";

// jsdom has no Element.scrollTo — a real implementation (not a no-op stub)
// so the reading-position restore tests can assert on the RESULTING
// scrollTop, matching how a real browser's scrollTo({top}) behaves for the
// "auto" (non-smooth) behavior this viewer always requests.
if (!("scrollTo" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: function scrollTo(this: HTMLElement, opts: ScrollToOptions) {
      if (opts && typeof opts.top === "number") this.scrollTop = opts.top;
    },
  });
}

/** jsdom never runs real layout, so offsetTop/offsetHeight are always 0 —
 *  this fakes a chapter placeholder's SCALED geometry (design_epub_position
 *  §3's coordinate system) so restore/save tests can exercise real numbers.
 *  Command (void). */
function stubGeom(el: HTMLElement, top: number, height: number): void {
  Object.defineProperty(el, "offsetTop", { value: top, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: height, configurable: true });
}

const setTocOverride = vi.fn();
registerEpubViewer({ setTocOverride });

let editorHost: HTMLElement;

beforeEach(() => {
  editorHost = document.createElement("div");
  editorHost.className = "editor-host";
  document.body.append(editorHost);
  const docTitleSlot = document.createElement("div");
  docTitleSlot.className = "title-bar-doc-title";
  const viewerSlotFixture = document.createElement("div");
  viewerSlotFixture.className = "title-bar-viewer-slot";
  document.body.append(docTitleSlot, viewerSlotFixture);
  invokeMock.mockClear();
  setTocOverride.mockClear();
  // epubPositionsSetting is a module-level singleton (defineSetting caches
  // its value in-memory at first import) — reset between tests so a save in
  // one test can never leak into the next's restore/save assertions.
  epubPositionsSetting.set({});
});
afterEach(() => {
  editorHost.remove();
  document.querySelectorAll(".title-bar-doc-title, .title-bar-viewer-slot").forEach((n) => n.remove());
  document.querySelector(".viewer-backdrop")?.remove();
});

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** Same drain as `flush`, but for a `vi.useFakeTimers()` context — fake
 *  timers don't affect native Promise microtasks, but `invoke`'s mock
 *  promises still need a few ticks to resolve/chain through the open()
 *  flow's several `await`s. `advanceTimersByTimeAsync(0)` flushes
 *  microtasks between (zero-length) timer advances, mirroring
 *  editor-autosave.test.ts's "settle the force-save promise" idiom. */
async function flushAsync(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await vi.advanceTimersByTimeAsync(0);
}

describe("registerEpubViewer registry shape", () => {
  it("registers id epub for the epub extension", () => {
    const v = viewerFor("epub");
    expect(v?.id).toBe("epub");
    expect(v?.extensions).toEqual(["epub"]);
  });
});

describe("openEpubViewer: open flow + loading state", () => {
  it("shows a loading status immediately, then arm_epub_view reject shows an error status", async () => {
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/bad.epub");
    expect(document.querySelector(".epub-viewer-status")?.textContent).toContain("불러오는 중");
    await flush();
    expect(document.querySelector(".epub-viewer-status")?.textContent).toContain("열 수 없습니다");
    expect(document.querySelector(".epub-viewer-chapters")).toBeNull();
    handle.close();
  });
});

describe("openEpubViewer: DRM gate", () => {
  it("rejects a DRM-protected book with epubOpenErrorMessage('drm') and creates zero chapter iframes", async () => {
    invokeMock.mockImplementation(fixtureInvoke("drm"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/drm.epub");
    await flush();

    const status = document.querySelector(".epub-viewer-status");
    expect(status?.textContent).toContain("DRM으로 보호된 EPUB");
    expect(document.querySelectorAll("iframe.epub-viewer-chapter-frame")).toHaveLength(0);

    handle.close();
  });
});

describe("openEpubViewer: backend error-string mapping (armErrorMessage / no-rootfile / corrupt)", () => {
  it("maps arm_epub_view's bare 'not-zip' rejection to epubOpenErrorMessage('not-zip')", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/notzip.epub");
    await flush();

    expect(document.querySelector(".epub-viewer-status")?.textContent).toContain("EPUB 형식이 아닙니다");
    handle.close();
  });

  it("maps a missing META-INF/container.xml to epubOpenErrorMessage('no-rootfile')", async () => {
    invokeMock.mockImplementation(fixtureInvoke("no-container"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    expect(document.querySelector(".epub-viewer-status")?.textContent).toContain("container.xml");
    handle.close();
  });

  it("maps a missing OPF (rootfile) entry to epubOpenErrorMessage('corrupt')", async () => {
    invokeMock.mockImplementation(fixtureInvoke("no-opf"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    expect(document.querySelector(".epub-viewer-status")?.textContent).toContain("손상된 EPUB 파일");
    handle.close();
  });
});

describe("openEpubViewer: normal book — chapters, sandbox, no raw HTML in app DOM", () => {
  it("creates one placeholder per spine entry; jsdom fallback sets iframe src to epub://<token>/<entry>", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    expect(chaptersEl).toBeTruthy();
    const placeholders = chaptersEl.querySelectorAll(".epub-viewer-chapter");
    expect(placeholders).toHaveLength(2);

    const iframes = chaptersEl.querySelectorAll("iframe.epub-viewer-chapter-frame");
    expect(iframes).toHaveLength(2);
    expect((iframes[0] as HTMLIFrameElement).src).toContain(epubViewUrl("token-normal", "OEBPS/text/ch1.xhtml"));
    expect((iframes[1] as HTMLIFrameElement).src).toContain(epubViewUrl("token-normal", "OEBPS/text/ch2.xhtml"));

    handle.close();
  });

  it("every chapter iframe's sandbox is exactly 'allow-scripts allow-same-origin'; the book's HTML never enters the app DOM directly", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    const iframes = document.querySelectorAll("iframe.epub-viewer-chapter-frame");
    expect(iframes.length).toBeGreaterThan(0);
    for (const iframe of Array.from(iframes)) {
      expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    }
    // No book markup (e.g. the toc's own chapter text "Chapter 1") ever
    // appears as literal DOM text/innerHTML content of the chapters column —
    // it only exists as the iframe's cross-document `src`.
    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    expect(chaptersEl.innerHTML).not.toContain("<script");

    handle.close();
  });

  it("parses the toc and calls setTocOverride with jump()-able items; close() restores it to null", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    expect(setTocOverride).toHaveBeenCalled();
    const items = setTocOverride.mock.calls[setTocOverride.mock.calls.length - 1][0];
    expect(items).toEqual([
      { level: 1, text: "Chapter 1", jump: expect.any(Function) },
      { level: 1, text: "Chapter 2", jump: expect.any(Function) },
    ]);

    handle.close();
    expect(setTocOverride).toHaveBeenLastCalledWith(null);
  });
});

describe("openEpubViewer: measure.js postMessage height sync + origin/source forgery guard", () => {
  it("a genuine message (matching origin + source) updates the chapter's iframe height", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    const iframe = document.querySelectorAll("iframe.epub-viewer-chapter-frame")[0] as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mermark-epub-size", height: 1234, anchors: { top: 10 } },
        origin: "epub://token-normal",
        source: iframe.contentWindow,
      }),
    );
    expect(iframe.style.height).toBe("1234px");

    handle.close();
  });

  it("ignores a message with a forged/foreign origin even if source matches a real chapter window", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    const iframe = document.querySelectorAll("iframe.epub-viewer-chapter-frame")[0] as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mermark-epub-size", height: 9999 },
        origin: "epub://forged-token",
        source: iframe.contentWindow,
      }),
    );
    expect(iframe.style.height).not.toBe("9999px");

    handle.close();
  });
});

describe("openEpubViewer: close guards a late-arriving load", () => {
  it("close() before the open() chain settles never resurrects chapter content", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    handle.close(); // close immediately, before any invoke resolves
    await flush();

    expect(document.querySelector(".epub-viewer-chapters")).toBeNull();
    expect(document.querySelector(".epub-viewer-status")).toBeNull(); // shell torn down entirely
  });

  it("close() is idempotent and unsubscribes the window message listener", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    handle.close();
    expect(() => handle.close()).not.toThrow();
    expect(removeSpy).toHaveBeenCalledWith("message", expect.any(Function));
    removeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Reading-position memory (_workspace/01_architect_plan_epub_position.md
// Stage P3). CH1 = "OEBPS/text/ch1.xhtml" (spine index 0), CH2 =
// "OEBPS/text/ch2.xhtml" (index 1) throughout — the fixture book's two
// chapters (OPF_XML/OPF_XML_WITH_ID above).
// ---------------------------------------------------------------------------

const CH1 = "OEBPS/text/ch1.xhtml";
const CH2 = "OEBPS/text/ch2.xhtml";

function seedPosition(key: string, pos: EpubReadingPosition): void {
  epubPositionsSetting.set({ ...epubPositionsSetting.get(), [key]: pos });
}

describe("openEpubViewer: reading-position restore — re-aim + cancel conditions", () => {
  it("re-aims to the target chapter's anchor on each measure message, using the CURRENT geometry", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    seedPosition("path:/vault/sample.epub", { entry: CH2, ratio: 0.9, anchor: "mid", savedAt: 1 });

    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    const placeholders = chaptersEl.querySelectorAll<HTMLElement>(".epub-viewer-chapter");
    stubGeom(placeholders[1], 500, 1000); // ch2's CURRENT (post-load) geometry

    const ch2Iframe = document.querySelectorAll("iframe.epub-viewer-chapter-frame")[1] as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mermark-epub-size", height: 1000, anchors: { mid: 200 } },
        origin: "epub://token-normal",
        source: ch2Iframe.contentWindow,
      }),
    );

    expect(chaptersEl.scrollTop).toBe(500 + 200 * 1); // geom.top + anchor(unscaled) × zoom(1)
    handle.close();
  });

  it("a user 'wheel' event cancels the restore — a later measure message no longer moves scrollTop", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    seedPosition("path:/vault/sample.epub", { entry: CH2, ratio: 0.9, anchor: "mid", savedAt: 1 });

    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    const placeholders = chaptersEl.querySelectorAll<HTMLElement>(".epub-viewer-chapter");
    stubGeom(placeholders[1], 500, 1000);
    const ch2Iframe = document.querySelectorAll("iframe.epub-viewer-chapter-frame")[1] as HTMLIFrameElement;

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mermark-epub-size", height: 1000, anchors: { mid: 200 } },
        origin: "epub://token-normal",
        source: ch2Iframe.contentWindow,
      }),
    );
    expect(chaptersEl.scrollTop).toBe(700);

    chaptersEl.scrollTop = 42; // the reader takes over
    window.dispatchEvent(new Event("wheel"));

    stubGeom(placeholders[1], 500, 5000); // a wildly different geometry, if re-aim ran it would move scrollTop
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mermark-epub-size", height: 5000, anchors: { mid: 4000 } },
        origin: "epub://token-normal",
        source: ch2Iframe.contentWindow,
      }),
    );
    expect(chaptersEl.scrollTop).toBe(42); // unchanged — restore stayed cancelled

    handle.close();
  });

  it("start-point positions (first chapter, ratio≈0, no anchor) are never restored — no scrollTo attempt at all", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    seedPosition("path:/vault/sample.epub", { entry: CH1, ratio: 0.001, anchor: null, savedAt: 1 });

    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    const ch1Iframe = document.querySelectorAll("iframe.epub-viewer-chapter-frame")[0] as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mermark-epub-size", height: 900, anchors: { far: 800 } },
        origin: "epub://token-normal",
        source: ch1Iframe.contentWindow,
      }),
    );
    expect(chaptersEl.scrollTop).toBe(0); // no restore was ever pending, so no re-aim scrollTo fired

    handle.close();
  });

  it("a saved entry no longer in the spine is never restored (identifier-collision safety net)", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    seedPosition("path:/vault/sample.epub", { entry: "OEBPS/text/ch99.xhtml", ratio: 0.5, anchor: null, savedAt: 1 });

    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    const ch1Iframe = document.querySelectorAll("iframe.epub-viewer-chapter-frame")[0] as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mermark-epub-size", height: 900, anchors: { far: 800 } },
        origin: "epub://token-normal",
        source: ch1Iframe.contentWindow,
      }),
    );
    expect(chaptersEl.scrollTop).toBe(0);

    handle.close();
  });

  it("a toc jump cancels an in-progress restore — a later measure for the OLD target no longer re-aims", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    seedPosition("path:/vault/sample.epub", { entry: CH2, ratio: 0.5, anchor: "mid", savedAt: 1 });

    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    const placeholders = chaptersEl.querySelectorAll<HTMLElement>(".epub-viewer-chapter");
    stubGeom(placeholders[0], 0, 400); // ch1 (the toc-jump target)
    stubGeom(placeholders[1], 500, 1000); // ch2 (the restore target)

    const items = setTocOverride.mock.calls[setTocOverride.mock.calls.length - 1][0] as { jump(): void }[];
    items[0].jump(); // "Chapter 1" — no fragment, so lands exactly at ch1's offsetTop (0)
    expect(chaptersEl.scrollTop).toBe(0);

    const ch2Iframe = document.querySelectorAll("iframe.epub-viewer-chapter-frame")[1] as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mermark-epub-size", height: 1000, anchors: { mid: 900 } },
        origin: "epub://token-normal",
        source: ch2Iframe.contentWindow,
      }),
    );
    expect(chaptersEl.scrollTop).toBe(0); // restore was cancelled by the jump — this message no longer re-aims

    handle.close();
  });
});

describe("openEpubViewer: reading-position save — key selection + teardown flush", () => {
  it("close() flushes the last (un-debounced) scroll position under the path: key (no OPF identifier)", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    const placeholders = chaptersEl.querySelectorAll<HTMLElement>(".epub-viewer-chapter");
    stubGeom(placeholders[0], 0, 1000);
    stubGeom(placeholders[1], 1000, 2000);
    chaptersEl.scrollTop = 1500; // 0.25 into ch2
    chaptersEl.dispatchEvent(new Event("scroll"));

    handle.close(); // before the 800ms debounce window elapses

    const saved = epubPositionsSetting.get()["path:/vault/sample.epub"];
    expect(saved?.entry).toBe(CH2);
    expect(saved?.ratio).toBeCloseTo(0.25, 5);
    expect(saved?.anchor).toBeNull();
  });

  it("close() flushes under the id: key when the OPF declares a dc:identifier", async () => {
    invokeMock.mockImplementation(fixtureInvoke("with-id"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/withid.epub");
    await flush();

    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    const placeholders = chaptersEl.querySelectorAll<HTMLElement>(".epub-viewer-chapter");
    stubGeom(placeholders[0], 0, 1000);
    stubGeom(placeholders[1], 1000, 2000);
    chaptersEl.scrollTop = 1000; // exactly ch2's start
    chaptersEl.dispatchEvent(new Event("scroll"));

    handle.close();

    expect(epubPositionsSetting.get()["id:urn:isbn:test-book"]?.entry).toBe(CH2);
    expect(epubPositionsSetting.get()["path:/vault/withid.epub"]).toBeUndefined();
  });

  it("pendingRestore gates the teardown flush — closing mid-restore leaves the EXISTING saved value untouched", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    const original: EpubReadingPosition = { entry: CH1, ratio: 0.3, anchor: null, savedAt: 1 };
    seedPosition("path:/vault/sample.epub", original);
    // shouldRestorePosition needs a non-start position to actually trigger a
    // restore — CH1 at ratio 0.3 qualifies (past the start-ratio epsilon).

    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flush();

    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    chaptersEl.scrollTop = 999; // simulate a scroll while restore is still pending
    chaptersEl.dispatchEvent(new Event("scroll"));

    handle.close(); // no wheel/measure/quiet/hard-timeout ever ended the restore

    expect(epubPositionsSetting.get()["path:/vault/sample.epub"]).toEqual(original);
  });
});

describe("openEpubViewer: reading-position save — debounce timing + restore gate (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves ~800ms after the LAST scroll, and two scrolls within the window save only once", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flushAsync();

    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    const placeholders = chaptersEl.querySelectorAll<HTMLElement>(".epub-viewer-chapter");
    stubGeom(placeholders[0], 0, 1000);
    stubGeom(placeholders[1], 1000, 2000);

    const setSpy = vi.spyOn(epubPositionsSetting, "set");

    chaptersEl.scrollTop = 100;
    chaptersEl.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(400);
    expect(setSpy).not.toHaveBeenCalled();

    chaptersEl.scrollTop = 1500; // a second scroll resets the debounce window
    chaptersEl.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(400); // 800ms since the FIRST scroll, but only 400 since the second
    expect(setSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400); // now 800ms since the second scroll
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(epubPositionsSetting.get()["path:/vault/sample.epub"]?.entry).toBe(CH2); // the SECOND scroll's position

    setSpy.mockRestore();
    handle.close();
  });

  it("a scroll during pendingRestore never saves, even after the debounce window elapses", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    seedPosition("path:/vault/sample.epub", { entry: CH1, ratio: 0.3, anchor: null, savedAt: 1 });
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flushAsync();

    const setSpy = vi.spyOn(epubPositionsSetting, "set");
    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    chaptersEl.scrollTop = 250;
    chaptersEl.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(900); // well past the 800ms debounce

    expect(setSpy).not.toHaveBeenCalled(); // pendingRestore gate held throughout

    setSpy.mockRestore();
    handle.close();
  });

  it("quiet convergence (~600ms after the target's own measure) ends the restore and re-enables saving", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    seedPosition("path:/vault/sample.epub", { entry: CH2, ratio: 0.5, anchor: null, savedAt: 1 });
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flushAsync();

    const ch2Iframe = document.querySelectorAll("iframe.epub-viewer-chapter-frame")[1] as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "mermark-epub-size", height: 800, anchors: {} },
        origin: "epub://token-normal",
        source: ch2Iframe.contentWindow,
      }),
    );
    await vi.advanceTimersByTimeAsync(600); // RESTORE_QUIET_MS — no further measures arrive

    // Proxy for "pendingRestore is now false": a scroll's debounced save now
    // succeeds (it would have been gated to a no-op while still pending).
    const setSpy = vi.spyOn(epubPositionsSetting, "set");
    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    chaptersEl.scrollTop = 50;
    chaptersEl.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(800);
    expect(setSpy).toHaveBeenCalledTimes(1);

    setSpy.mockRestore();
    handle.close();
  });

  it("the hard timeout (~10s) ends a restore whose target never measures, re-enabling saving", async () => {
    invokeMock.mockImplementation(fixtureInvoke("normal"));
    seedPosition("path:/vault/sample.epub", { entry: CH2, ratio: 0.5, anchor: null, savedAt: 1 });
    const v = viewerFor("epub")!;
    const handle = v.open("/vault/sample.epub");
    await flushAsync();

    await vi.advanceTimersByTimeAsync(10_000); // RESTORE_HARD_TIMEOUT_MS, no measure ever arrived

    const setSpy = vi.spyOn(epubPositionsSetting, "set");
    const chaptersEl = document.querySelector(".epub-viewer-chapters") as HTMLElement;
    chaptersEl.scrollTop = 50;
    chaptersEl.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(800);
    expect(setSpy).toHaveBeenCalledTimes(1);

    setSpy.mockRestore();
    handle.close();
  });
});
