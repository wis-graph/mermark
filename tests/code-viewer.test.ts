import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Stage C (01_architect_plan.md §1 Stage C) — the code viewer's registration +
// open() behavior. `vi.mock("@tauri-apps/api/core")` mirrors
// tests/viewer-remote-contract.test.ts's pattern; `fetch` is stubbed per-test
// (vi.stubGlobal) to hand back whatever bytes that test needs, mirroring
// html-viewer.test.ts's fetch-stub usage.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string, protocol?: string) => `${protocol ?? "asset"}://localhost${p}`,
  invoke: vi.fn(async () => undefined),
}));

import { registerCodeViewer } from "../src/extensions/code-viewer";
import { registerDocxViewer } from "../src/extensions/docx-viewer";
import { registerHtmlViewer } from "../src/extensions/html-viewer";
import { registerExcelViewer } from "../src/extensions/excel-viewer";
import { registerPdfViewer } from "../src/extensions/pdf-viewer";
import { registerViewer, viewerFor, viewerSupportsRemote } from "../src/chrome/viewer/registry";
import {
  decodeSourceText,
  splitLines,
  HIGHLIGHT_MAX_LINES,
  DISPLAY_MAX_BYTES,
  DISPLAY_TOO_LARGE_MESSAGE,
  HIGHLIGHT_DISABLED_MESSAGE,
  BINARY_FILE_MESSAGE,
} from "../src/extensions/code-viewer/source-text";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_TS_TEXT = readFileSync(join(ROOT, "mock-assets", "mock", "vault", "sample.ts"), "utf8");
const FIXTURE_TS_BYTES = new TextEncoder().encode(FIXTURE_TS_TEXT).buffer as ArrayBuffer;

let editorHost: HTMLElement;

function mountShellFixture(): void {
  editorHost = document.createElement("div");
  editorHost.className = "editor-host";
  document.body.append(editorHost);
  const docTitleSlot = document.createElement("div");
  docTitleSlot.className = "title-bar-doc-title";
  const viewerSlotFixture = document.createElement("div");
  viewerSlotFixture.className = "title-bar-viewer-slot";
  document.body.append(docTitleSlot, viewerSlotFixture);
}

function unmountShellFixture(): void {
  editorHost.remove();
  document.querySelectorAll(".title-bar-doc-title, .title-bar-viewer-slot, .viewer-backdrop").forEach((n) => n.remove());
}

/** Stub `fetch` to resolve `bytes` (or reject) for every call — a code
 *  viewer open() only ever fetches ONE url per open, so per-test bytes are
 *  enough (mirrors html-viewer.test.ts's stubGlobal usage). */
function stubFetchBytes(bytes: ArrayBuffer | (() => ArrayBuffer) | { reject: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (typeof bytes === "object" && bytes !== null && "reject" in bytes) {
        throw bytes.reject;
      }
      const buf = typeof bytes === "function" ? bytes() : bytes;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => buf,
      } as unknown as Response;
    }),
  );
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  mountShellFixture();
});

afterEach(() => {
  document.querySelectorAll(".code-viewer, .viewer-panel").forEach((n) => n.remove());
  unmountShellFixture();
  vi.unstubAllGlobals();
});

describe("code viewer registration", () => {
  it('registerCodeViewer() claims "ts" — viewerFor("ts") resolves to id "ext.code", label "소스 코드", remote-capable', () => {
    registerCodeViewer();
    const v = viewerFor("ts");
    expect(v).not.toBeNull();
    expect(v?.id).toBe("ext.code");
    expect(v?.label).toBe("소스 코드");
    expect(viewerSupportsRemote(v!)).toBe(true);
  });

  it("a second registerCodeViewer() call throws (registerViewer's own duplicate-id guard)", () => {
    expect(() => registerCodeViewer()).toThrow(/already registered/);
  });
});

describe("code viewer exclusivity (does not claim what other viewers own)", () => {
  beforeEach(() => {
    registerDocxViewer();
    registerHtmlViewer();
    registerExcelViewer();
    registerPdfViewer();
    registerViewer({
      id: "image",
      extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"],
      open: () => ({ close() {}, onClose() {} }),
    });
  });

  it("html/csv/md/txt/markdown resolve to the correct owner (or none)", () => {
    expect(viewerFor("html")?.id).toBe("ext.html");
    expect(viewerFor("csv")?.id).toBe("ext.excel");
    expect(viewerFor("md")).toBeNull();
    expect(viewerFor("txt")).toBeNull();
    expect(viewerFor("markdown")).toBeNull();
  });
});

describe("openCodeViewer: highlighted open (mapped language, within caps)", () => {
  it("renders one .code-viewer-line per source line, highlighted, no banner", async () => {
    stubFetchBytes(FIXTURE_TS_BYTES);
    const v = viewerFor("ts")!;
    const handle = v.open("/mock/vault/sample.ts");
    await waitFor(() => document.querySelectorAll(".code-viewer-line").length > 0);

    const lines = document.querySelectorAll(".code-viewer-line");
    expect(lines.length).toBe(20);

    expect(document.querySelectorAll(".hljs-keyword").length).toBeGreaterThanOrEqual(1);

    // The fixture's 3-line block comment (lines 4-6: "/**" / " * 안녕 인사를
    // 만든다." / " */") re-opens the hljs-comment span across all 3 rows —
    // the reopening-across-newlines evidence splitHighlightedHtmlByLine's
    // own unit tests pin structurally. (Line 1's leading "//" note is ALSO a
    // comment — deliberately excluded from this count, which targets only
    // the re-opening block.)
    const blockCommentLines = [lines[3], lines[4], lines[5]];
    for (const line of blockCommentLines) {
      expect(line.querySelector(".hljs-comment")).not.toBeNull();
    }

    // .textContent joins rows with "\n" separators (not trailing) — matches
    // splitLines(...).join("\n"), i.e. decodeSourceText with its single
    // trailing-newline artifact (splitLines' own documented drop rule)
    // removed. No line-number text is present (those live only in the
    // ::before counter) — that absence IS this assertion's whole point.
    const codeRoot = document.querySelector(".code-viewer-code")!;
    expect(codeRoot.textContent).toBe(splitLines(decodeSourceText(FIXTURE_TS_BYTES)).join("\n"));

    expect(document.querySelectorAll(".code-viewer-banner").length).toBe(0);

    handle.close();
  });
});

describe("openCodeViewer: plain-text open (unmapped language, e.g. .gradle)", () => {
  it("renders the same line count as plain text, no hljs classes, no banner", async () => {
    const text = "plugins {\n  id 'java'\n}\n";
    stubFetchBytes(new TextEncoder().encode(text).buffer as ArrayBuffer);
    const v = viewerFor("gradle")!;
    const handle = v.open("/mock/vault/build.gradle");
    await waitFor(() => document.querySelectorAll(".code-viewer-line").length > 0);

    expect(document.querySelectorAll(".code-viewer-line").length).toBe(3);
    expect(document.querySelectorAll("[class*=hljs-]").length).toBe(0);
    expect(document.querySelectorAll(".code-viewer-banner").length).toBe(0);

    handle.close();
  });
});

describe("openCodeViewer: highlight disabled over the line cap", () => {
  it("shows the HIGHLIGHT_DISABLED_MESSAGE banner, plain text, same line count", async () => {
    const text = Array.from({ length: HIGHLIGHT_MAX_LINES + 1 }, (_, i) => `const x${i} = ${i};`).join("\n");
    stubFetchBytes(new TextEncoder().encode(text).buffer as ArrayBuffer);
    const v = viewerFor("ts")!;
    const handle = v.open("/mock/vault/huge.ts");
    await waitFor(() => document.querySelectorAll(".code-viewer-line").length > 0, 5000);

    const banner = document.querySelector(".code-viewer-banner");
    expect(banner?.textContent).toBe(HIGHLIGHT_DISABLED_MESSAGE);
    expect(document.querySelectorAll("[class*=hljs-]").length).toBe(0);
    expect(document.querySelectorAll(".code-viewer-line").length).toBe(HIGHLIGHT_MAX_LINES + 1);

    handle.close();
  }, 10000);
});

describe("openCodeViewer: display refused over DISPLAY_MAX_BYTES", () => {
  it("shows DISPLAY_TOO_LARGE_MESSAGE, no lines, and never decodes", async () => {
    const decodeSpy = vi.spyOn(TextDecoder.prototype, "decode");
    const oversized = new Uint8Array(DISPLAY_MAX_BYTES + 1).fill(0x20).buffer;
    stubFetchBytes(oversized);
    const v = viewerFor("ts")!;
    const handle = v.open("/mock/vault/huge2.ts");
    await waitFor(() => document.querySelector(".code-viewer-status")?.textContent !== "파일 불러오는 중…");

    const status = document.querySelector(".code-viewer-status");
    expect(status?.textContent).toBe(DISPLAY_TOO_LARGE_MESSAGE);
    expect(document.querySelectorAll(".code-viewer-line").length).toBe(0);
    expect(decodeSpy).not.toHaveBeenCalled();

    decodeSpy.mockRestore();
    handle.close();
  });
});

describe("openCodeViewer: binary file refused", () => {
  it("shows BINARY_FILE_MESSAGE", async () => {
    const bytes = new Uint8Array([0x68, 0x00, 0x69]).buffer;
    stubFetchBytes(bytes);
    const v = viewerFor("ts")!;
    const handle = v.open("/mock/vault/binary.ts");
    await waitFor(() => document.querySelector(".code-viewer-status")?.textContent !== "파일 불러오는 중…");

    expect(document.querySelector(".code-viewer-status")?.textContent).toBe(BINARY_FILE_MESSAGE);
    handle.close();
  });
});

describe("openCodeViewer: fetch failure", () => {
  it('status text is prefixed with "문서를 열 수 없습니다:"', async () => {
    stubFetchBytes({ reject: new Error("network down") });
    const v = viewerFor("ts")!;
    const handle = v.open("/mock/vault/fails.ts");
    await waitFor(() => document.querySelector(".code-viewer-status")?.textContent !== "파일 불러오는 중…");

    expect(document.querySelector(".code-viewer-status")?.textContent).toMatch(/^문서를 열 수 없습니다:/);
    handle.close();
  });
});

describe("openCodeViewer: close lifecycle", () => {
  it("close() removes the pane, fires onClose once, is idempotent; style tag stays singular across opens", async () => {
    stubFetchBytes(FIXTURE_TS_BYTES);
    const v = viewerFor("ts")!;
    const handle = v.open("/mock/vault/sample.ts");
    await waitFor(() => document.querySelectorAll(".code-viewer-line").length > 0);

    let closeCount = 0;
    handle.onClose(() => {
      closeCount += 1;
    });
    handle.close();
    expect(document.querySelectorAll(".code-viewer").length).toBe(0);
    expect(closeCount).toBe(1);
    handle.close();
    expect(closeCount).toBe(1);

    expect(document.querySelectorAll("#ext-code-viewer-style").length).toBe(1);

    stubFetchBytes(FIXTURE_TS_BYTES);
    const handle2 = v.open("/mock/vault/sample.ts");
    await waitFor(() => document.querySelectorAll(".code-viewer-line").length > 0);
    expect(document.querySelectorAll("#ext-code-viewer-style").length).toBe(1);
    handle2.close();
  });
});

describe(".ext-code-viewer-style CSS contract", () => {
  const ROOT2 = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(ROOT2, "src", "extensions", "code-viewer", "index.ts"), "utf8");

  it("declares the line-number gutter via CSS counter, user-select:none, white-space:pre", () => {
    expect(src).toMatch(/\.code-viewer-line::before/);
    expect(src).toMatch(/counter\(/);
    expect(src).toMatch(/user-select:\s*none/);
    expect(src).toMatch(/white-space:\s*pre/);
  });

  it("consumes --viewer-zoom for content font-size", () => {
    expect(src).toMatch(/var\(--viewer-zoom/);
  });

  it("declares dark-default + light + claude theme blocks for .code-viewer", () => {
    expect(src).toMatch(/:root\[data-theme="light"\]\s*\.code-viewer/);
    expect(src).toMatch(/:root\[data-theme="claude"\]\s*\.code-viewer/);
  });

  it(".code-viewer root rule declares no width/height/max-*", () => {
    const rootRule = /\.code-viewer\s*\{([^}]*)\}/.exec(src);
    expect(rootRule).toBeTruthy();
    expect(rootRule![1]).not.toMatch(/(?:^|[;\s])(width|height|max-width|max-height)\s*:/);
  });
});

describe("cold-load contract: hljs is never imported at module top-level", () => {
  const ROOT3 = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(ROOT3, "src", "extensions", "code-viewer", "index.ts"), "utf8");

  it('no top-level `import ... from "highlight.js` — only a dynamic import("highlight.js/lib/common")', () => {
    expect(src).not.toMatch(/^import[^;]*from\s+["']highlight\.js/m);
    expect(src).toMatch(/import\(\s*["']highlight\.js\/lib\/common["']\s*\)/);
  });
});
