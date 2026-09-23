import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// T6 (0.18.0, _workspace/01_architect_design.md §4.4): the ONE test surface
// that pins "remote support is a Viewer's own declaration, not a hand-kept
// extension list" — the exact structural fix for a leak class this repo has
// hit 6 times (a new/existing viewer accidentally receiving a vault-relative
// path through its LOCAL `open(absPath)`).
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "remote_read_asset") return new TextEncoder().encode("mock remote bytes").buffer;
  if (cmd === "arm_html_view_root") return "mock-view-token";
  if (cmd === "arm_remote_html_view_root") return "mock-remote-view-token";
  void args;
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string, protocol?: string) => `${protocol ?? "asset"}://localhost${p}`,
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args as Record<string, unknown>),
}));

import { registerPdfViewer } from "../src/extensions/pdf-viewer";
import { registerDocxViewer } from "../src/extensions/docx-viewer";
import { registerExcelViewer } from "../src/extensions/excel-viewer";
import { registerHtmlViewer } from "../src/extensions/html-viewer";
import { registerCodeViewer } from "../src/extensions/code-viewer";
import { CODE_VIEWER_EXTENSIONS } from "../src/extensions/code-viewer/language-map";
import { registerSqliteViewer } from "../src/chrome/viewer/sqlite-viewer";
import { registerHwpViewer } from "../src/chrome/viewer/hwp-viewer";
import { registerEpubViewer } from "../src/chrome/viewer/epub-viewer";
import { listViewers, viewerFor, viewerSupportsRemote } from "../src/chrome/viewer/registry";
import { readRemoteFileBytes, isRemoteAssetTooLarge } from "../src/chrome/viewer/file-bytes";
import { htmlScriptsSetting } from "../src/settings/app";

registerPdfViewer();
registerDocxViewer();
registerExcelViewer();
registerHtmlViewer();
registerCodeViewer();
registerSqliteViewer();
registerHwpViewer();
registerEpubViewer({ setTocOverride: () => {} });

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
});
afterEach(() => {
  editorHost.remove();
  document.querySelectorAll(".title-bar-doc-title, .title-bar-viewer-slot").forEach((n) => n.remove());
  document.querySelector(".viewer-backdrop")?.remove();
  htmlScriptsSetting.set(false);
  invokeMock.mockClear();
});

async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const REMOTE_SOURCE = { host: "mac-mini", remoteVaultId: "rv1", path: "sub/표.xlsx" };

describe("remote support is declared by the viewer, not a hand-kept extension list", () => {
  it("원격 지원 여부는 뷰어가 선언한다", () => {
    const remoteCapable = listViewers()
      .filter(viewerSupportsRemote)
      .flatMap((v) => v.extensions)
      .sort();
    expect(remoteCapable).toEqual(
      ["csv", "docx", "htm", "html", "pdf", "xls", "xlsx", ...CODE_VIEWER_EXTENSIONS].sort(),
    );
  });

  it("로컬 디스크를 직접 읽는 뷰어는 openRemote를 선언하지 않는다", () => {
    for (const id of ["sqlite", "hwp", "epub"]) {
      const v = listViewers().find((x) => x.id === id);
      expect(v, `viewer "${id}" not registered`).toBeTruthy();
      expect(viewerSupportsRemote(v!)).toBe(false);
    }
  });
});

describe("readRemoteFileBytes", () => {
  it("convertFileSrc를 절대 거치지 않고 remote_read_asset을 정확한 인자로 부른다", async () => {
    await readRemoteFileBytes(REMOTE_SOURCE);
    expect(invokeMock).toHaveBeenCalledWith("remote_read_asset", { host: "mac-mini", vault: "rv1", path: "sub/표.xlsx" });
  });

  it("상한 초과는 '연결 안 됨'이 아니라 '파일이 큼'으로 보고된다", async () => {
    invokeMock.mockRejectedValueOnce("REMOTE_ASSET_TOO_LARGE: sub/big.xlsx");
    await expect(readRemoteFileBytes({ ...REMOTE_SOURCE, path: "sub/big.xlsx" })).rejects.toThrow(/너무 큽니다/);
  });

  it("isRemoteAssetTooLarge는 그 prefix만 잡는다 — 4-state 실패와 구분", () => {
    expect(isRemoteAssetTooLarge(new Error("REMOTE_ASSET_TOO_LARGE: x"))).toBe(true);
    expect(isRemoteAssetTooLarge("REMOTE_ASSET_TOO_LARGE: x")).toBe(true);
    expect(isRemoteAssetTooLarge(new Error("REMOTE:Unreachable"))).toBe(false);
  });
});

describe("bytes-only viewers open remotely with no local-path invoke", () => {
  it("pdf: openRemote는 remote_read_asset만 부르고 로컬 경로 커맨드를 부르지 않는다", async () => {
    const v = viewerFor("pdf")!;
    expect(v.openRemote).toBeTypeOf("function");
    const handle = v.openRemote!({ ...REMOTE_SOURCE, path: "sub/문서.pdf" });
    await flushAsync();
    const called = invokeMock.mock.calls.map((c) => c[0]);
    expect(called).toContain("remote_read_asset");
    expect(called).not.toContain("canonicalize_path");
    expect(called).not.toContain("watch_file");
    expect(called).not.toContain("open_path");
    handle.close();
  });

  it("docx: openRemote는 remote_read_asset을 부른다", async () => {
    const v = viewerFor("docx")!;
    const handle = v.openRemote!({ ...REMOTE_SOURCE, path: "sub/문서.docx" });
    await flushAsync();
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain("remote_read_asset");
    handle.close();
  });

  it("excel: openRemote는 remote_read_asset을 부른다 (csv 확장자 판정도 pathForCaption 기준으로 유지)", async () => {
    const v = viewerFor("xlsx")!;
    const handle = v.openRemote!({ ...REMOTE_SOURCE, path: "sub/표.csv" });
    await flushAsync();
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain("remote_read_asset");
    handle.close();
  });

  it("html (OFF): openRemote는 remote_read_asset을 부르고 arm_html_view_root는 부르지 않는다", async () => {
    const v = viewerFor("html")!;
    const handle = v.openRemote!({ ...REMOTE_SOURCE, path: "sub/페이지.html" });
    await flushAsync();
    const called = invokeMock.mock.calls.map((c) => c[0]);
    expect(called).toContain("remote_read_asset");
    expect(called).not.toContain("arm_html_view_root");
    handle.close();
  });

  it("html (ON): openRemote는 arm_remote_html_view_root를 부르고 arm_html_view_root(로컬)는 부르지 않는다", async () => {
    htmlScriptsSetting.set(true);
    const v = viewerFor("html")!;
    const handle = v.openRemote!({ ...REMOTE_SOURCE, path: "sub/page.html" });
    await flushAsync();
    expect(invokeMock).toHaveBeenCalledWith(
      "arm_remote_html_view_root",
      expect.objectContaining({ host: "mac-mini", vault: "rv1", dir: "sub" }),
    );
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain("arm_html_view_root");
    const iframe = document.querySelector(".html-viewer-frame") as HTMLIFrameElement | null;
    expect(iframe?.getAttribute("src")).toBe("htmlview://mock-remote-view-token/page.html");
    handle.close();
  });

  it("code: openRemote는 remote_read_asset만 부르고 로컬 경로 커맨드를 부르지 않는다", async () => {
    const v = viewerFor("ts")!;
    expect(v.openRemote).toBeTypeOf("function");
    const handle = v.openRemote!({ ...REMOTE_SOURCE, path: "sub/문서.ts" });
    // openCodeViewerFromBytes has one more await hop than the bytes-only
    // viewers above (hljsLoader's real dynamic import) — poll instead of a
    // single flushAsync tick.
    const start = Date.now();
    while (document.querySelectorAll(".code-viewer-line").length === 0) {
      if (Date.now() - start > 2000) throw new Error("timed out waiting for .code-viewer-line");
      await new Promise((r) => setTimeout(r, 5));
    }
    const called = invokeMock.mock.calls.map((c) => c[0]);
    expect(called).toContain("remote_read_asset");
    expect(called).not.toContain("canonicalize_path");
    expect(called).not.toContain("watch_file");
    expect(called).not.toContain("open_path");
    handle.close();
  });
});
