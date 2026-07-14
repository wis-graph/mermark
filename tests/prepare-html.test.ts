import { describe, it, expect } from "vitest";
import {
  sniffDeclaredCharset,
  decodeHtmlBytes,
  rewriteRelativeSrcAttrs,
} from "../src/extensions/html-viewer/prepare-html";

// R11 2단계 (_workspace/01_html_viewer.md §7 TDD step 1): pure functions
// only, no DOM mount, no editor — these exercise `prepare-html.ts` directly
// the way `sheetToRows`/`truncatedForRender` exercise Excel's pure layer.

function asciiBytes(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

describe("sniffDeclaredCharset", () => {
  it("defaults to utf-8 when no meta charset declaration exists", () => {
    expect(sniffDeclaredCharset(asciiBytes("<html><head></head><body>hi</body></html>"))).toBe("utf-8");
  });

  it("detects the modern <meta charset=...> form", () => {
    expect(sniffDeclaredCharset(asciiBytes('<html><head><meta charset="euc-kr"></head></html>'))).toBe(
      "euc-kr",
    );
  });

  it("detects the modern form unquoted", () => {
    expect(sniffDeclaredCharset(asciiBytes("<meta charset=EUC-KR>"))).toBe("euc-kr");
  });

  it("detects the legacy http-equiv Content-Type form", () => {
    const head =
      '<head><meta http-equiv="Content-Type" content="text/html; charset=euc-kr"></head>';
    expect(sniffDeclaredCharset(asciiBytes(head))).toBe("euc-kr");
  });
});

describe("decodeHtmlBytes", () => {
  it("decodes plain ASCII/UTF-8 content with no declared charset", () => {
    const html = "<html><body>hello world</body></html>";
    const bytes = new TextEncoder().encode(html).buffer;
    expect(decodeHtmlBytes(bytes)).toBe(html);
  });

  it("decodes EUC-KR-encoded content declared via <meta charset> — restores 한글", () => {
    // "한글" in EUC-KR, confirmed via `printf '한글' | iconv -f UTF-8 -t EUC-KR | xxd`
    // -> c7 d1 b1 db.
    const head = asciiBytes('<html><head><meta charset="euc-kr"></head><body>');
    const koreanBytes = new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]);
    const tail = asciiBytes("</body></html>");
    const bytes = new Uint8Array(head.length + koreanBytes.length + tail.length);
    bytes.set(head, 0);
    bytes.set(koreanBytes, head.length);
    bytes.set(tail, head.length + koreanBytes.length);

    const decoded = decodeHtmlBytes(bytes.buffer);
    expect(decoded).toContain("한글");
  });

  it("falls back to utf-8 when the declared charset label is unrecognized", () => {
    const html = '<html><head><meta charset="not-a-real-charset"></head><body>hello</body></html>';
    const bytes = new TextEncoder().encode(html).buffer;
    expect(decodeHtmlBytes(bytes)).toContain("hello");
  });
});

describe("rewriteRelativeSrcAttrs (design §3.4/§5)", () => {
  const identity = (abs: string) => `asset://localhost${abs}`;

  it("rewrites a relative img src to an asset URL joined against the directory", () => {
    const out = rewriteRelativeSrcAttrs('<img src="chart.png">', "/vault/dir", identity);
    expect(out).toContain('src="asset://localhost/vault/dir/chart.png"');
  });

  it("rewrites a ./-prefixed relative src identically to a bare relative one", () => {
    const out = rewriteRelativeSrcAttrs('<img src="./chart.png">', "/vault/dir", identity);
    expect(out).toContain('src="asset://localhost/vault/dir/chart.png"');
  });

  it("rewrites source/video/audio src the same way as img", () => {
    const out = rewriteRelativeSrcAttrs(
      '<video><source src="clip.mp4"></video><audio src="clip.mp3"></audio>',
      "/vault/dir",
      identity,
    );
    expect(out).toContain('src="asset://localhost/vault/dir/clip.mp4"');
    expect(out).toContain('src="asset://localhost/vault/dir/clip.mp3"');
  });

  it("leaves http(s) absolute URLs unchanged", () => {
    const out = rewriteRelativeSrcAttrs('<img src="https://example.com/pic.png">', "/vault/dir", identity);
    expect(out).toContain('src="https://example.com/pic.png"');
  });

  it("leaves data: URLs unchanged", () => {
    const out = rewriteRelativeSrcAttrs('<img src="data:image/png;base64,AAAA">', "/vault/dir", identity);
    expect(out).toContain('src="data:image/png;base64,AAAA"');
  });

  it("leaves protocol-relative (//host/...) URLs unchanged", () => {
    const out = rewriteRelativeSrcAttrs('<img src="//example.com/pic.png">', "/vault/dir", identity);
    expect(out).toContain('src="//example.com/pic.png"');
  });

  it("leaves a relative CSS <link> unchanged — documented limitation (design §3.4), not silently 'fixed'", () => {
    const out = rewriteRelativeSrcAttrs(
      '<link rel="stylesheet" href="style.css"><img src="chart.png">',
      "/vault/dir",
      identity,
    );
    expect(out).toContain('href="style.css"');
    expect(out).toContain('src="asset://localhost/vault/dir/chart.png"');
  });

  it("passes a <script> tag through UNSTRIPPED — sanitize is explicitly not this function's job (design §3.5)", () => {
    const out = rewriteRelativeSrcAttrs(
      '<script>document.title="PWNED"</script><img src="chart.png">',
      "/vault/dir",
      identity,
    );
    expect(out).toContain("<script>");
    expect(out).toContain('document.title="PWNED"');
  });
});
