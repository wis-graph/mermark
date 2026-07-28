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
        return Promise.resolve(OPF_XML);
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
});
afterEach(() => {
  editorHost.remove();
  document.querySelectorAll(".title-bar-doc-title, .title-bar-viewer-slot").forEach((n) => n.remove());
  document.querySelector(".viewer-backdrop")?.remove();
});

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
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
