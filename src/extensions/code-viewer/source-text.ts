// Stage B (01_architect_plan.md §1 Stage B, design §4/§5/§7) — the source
// viewer's binary/size/text-splitting rules. Pure functions only: no DOM, no
// IO (html-viewer's `prepare-html.ts` precedent) — `index.ts`'s open()
// handler is the only place these get wired to real bytes.

/** How many leading bytes `looksBinary` sniffs for a NUL — git's own binary
 *  heuristic (a NUL in the first N bytes ⇒ binary), applied BEFORE decoding
 *  so a binary file never reaches `TextDecoder`. */
export const BINARY_SNIFF_BYTES = 8000;

/** Above this many bytes, highlighting is skipped even for a mapped
 *  language (a minified bundle: few lines, many bytes) — `shouldHighlight`'s
 *  byte half. */
export const HIGHLIGHT_MAX_BYTES = 512 * 1024;

/** Above this many lines, highlighting is skipped even for a small file (a
 *  huge generated/log file: many lines, modest bytes) — `shouldHighlight`'s
 *  line half. */
export const HIGHLIGHT_MAX_LINES = 10_000;

/** Above this many bytes, the file is refused entirely — one DOM node per
 *  line makes a file with hundreds of thousands of lines freeze the UI, and
 *  a remote source already caps at ~20 MiB host-side (design §4). Checked
 *  BEFORE decoding (`isDisplayable` takes a byte length, not text). */
export const DISPLAY_MAX_BYTES = 8 * 1024 * 1024;

export const BINARY_FILE_MESSAGE = "텍스트로 읽을 수 없는 파일입니다 (바이너리 데이터 포함)";
export const DISPLAY_TOO_LARGE_MESSAGE = "파일이 너무 커서 표시할 수 없습니다 (8MB 초과)";
export const HIGHLIGHT_DISABLED_MESSAGE = "파일이 커서 문법 강조를 껐습니다 (512KB 또는 10,000줄 초과)";

/** Does `bytes` look like binary data (git's rule: a NUL byte within the
 *  first `BINARY_SNIFF_BYTES`)? Called BEFORE decoding — a binary file never
 *  reaches `decodeSourceText`. Pure query. */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0x00) return true;
  }
  return false;
}

/** Decode raw bytes as UTF-8 (never throws — invalid sequences become
 *  U+FFFD replacement characters, same non-fatal contract `prepare-html.ts`
 *  uses), strip a leading BOM, and normalize CRLF/CR line endings to LF so
 *  every downstream function (`splitLines`, the line-per-row renderer) only
 *  ever sees `\n`. Pure query (no fatal decode errors — a caller that wants
 *  to reject invalid bytes checks `looksBinary`/size caps first). */
export function decodeSourceText(bytes: ArrayBuffer): string {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const withoutBom = decoded.startsWith("﻿") ? decoded.slice(1) : decoded;
  return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** The ONE terminal-newline rule both `splitLines` and
 *  `splitHighlightedHtmlByLine` need — extracted so the two can never drift
 *  out of sync (audit finding, `_workspace/04_audit_report.md`: this rule
 *  used to be inlined TWICE, and the second inlining — `html.endsWith("\n")`
 *  — silently broke whenever the source's final `\n` sat INSIDE a still-open
 *  hljs span, e.g. an unterminated block comment: hljs closes the span at
 *  end-of-input, so the highlighted HTML then ends with `</span>`, not a
 *  bare `\n`, even though the underlying source text still ends in one).
 *
 *  `items` is a line array already split on "\n" (so `items.length - 1` is
 *  the number of newlines in the original text); `lastItemHadRealText`
 *  tells whether the LAST entry carries any actual source character — for a
 *  plain split this is simply "last entry isn't the empty string", but for
 *  the highlighted path a not-empty last entry can still be ZERO real
 *  characters (only a reopened+closing tag pair), which is exactly the case
 *  this fix targets. A single trailing "\n" (one entry, no real text after
 *  it) is dropped; a genuinely blank line the user wrote (`"a\n\n"`, two
 *  trailing empty entries) is NOT — only the true artifact, and never the
 *  sole entry of an otherwise-empty document. Pure query. */
function withoutTrailingNewlineArtifact<T>(items: readonly T[], lastItemHadRealText: boolean): T[] {
  if (items.length > 1 && !lastItemHadRealText) return items.slice(0, -1);
  return items.slice();
}

/** Split already-LF-normalized `text` into lines, dropping the single empty
 *  "line" a trailing `\n` would otherwise produce (so a file with one
 *  trailing newline reports the same line count `wc -l` would) while
 *  preserving genuinely empty interior/trailing lines (`"a\n\n"` → two
 *  lines, the second empty). Pure query. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  return withoutTrailingNewlineArtifact(lines, lines[lines.length - 1] !== "");
}

/** Is a file of `byteLength` bytes safe to render at all (one DOM node per
 *  line, §DISPLAY_MAX_BYTES)? Checked on the RAW byte length, before
 *  decoding — decoding a file this refuses would itself be wasted work.
 *  Pure query. */
export function isDisplayable(byteLength: number): boolean {
  return byteLength <= DISPLAY_MAX_BYTES;
}

/** Is a displayable file small enough (both byte AND line count within cap)
 *  to run through hljs at all? Pure query. */
export function shouldHighlight(byteLength: number, lineCount: number): boolean {
  return byteLength <= HIGHLIGHT_MAX_BYTES && lineCount <= HIGHLIGHT_MAX_LINES;
}

export type SourceRenderPlan = "highlight" | "plain" | "plain-too-large";

/** The SOLE branch point `openCodeViewerFromBytes` (index.ts) dispatches
 *  on — no rule here is ever re-inlined at the call site. `language === null`
 *  (no hljs grammar claimed, e.g. `.gradle`) renders quietly as plain text
 *  with no banner; exceeding either highlight cap renders as plain text WITH
 *  a banner, regardless of whether a language was mapped (the banner reports
 *  a size fact, not a language fact) — a null language that ALSO exceeds the
 *  caps still reports `"plain-too-large"` for the same reason. Pure query. */
export function sourceRenderPlan(input: {
  language: string | null;
  byteLength: number;
  lineCount: number;
}): SourceRenderPlan {
  const withinCaps = shouldHighlight(input.byteLength, input.lineCount);
  if (!withinCaps) return "plain-too-large";
  return input.language === null ? "plain" : "highlight";
}

// hljs wraps highlighted spans in exactly `<span class="...">`/`</span>`
// around ALREADY html-escaped text (hljs's own output contract — design §5).
// A block comment or multi-line string ends up as ONE such span crossing
// several source lines; this scanner recognizes only these two token shapes.
const SPAN_TOKEN_RE = /<span class="[^"]*">|<\/span>/g;

/** Split hljs's single highlighted HTML string into one HTML string per
 *  source line, RE-OPENING any span that was still open at a line break (the
 *  same technique the highlightjs-line-numbers plugin uses, implemented as a
 *  pure string transform so it's unit-testable without a DOM). Line count
 *  and the terminal-newline rule match `splitLines` exactly (both go through
 *  `withoutTrailingNewlineArtifact`) — `hasRealTextSinceLastLine` tracks,
 *  independent of any tag markup, whether an actual source character has
 *  been appended since the last line was pushed, so a trailing `\n` that
 *  falls INSIDE a still-open span (its reopen+close tags contribute no real
 *  text) is correctly recognized as the artifact to drop. Pure query. */
export function splitHighlightedHtmlByLine(html: string): string[] {
  const lines: string[] = [];
  const openStack: string[] = [];
  let current = "";
  let hasRealTextSinceLastLine = false;

  function flushText(text: string): void {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].length > 0) hasRealTextSinceLastLine = true;
      current += parts[i];
      if (i < parts.length - 1) {
        current += openStack.map(() => "</span>").join("");
        lines.push(current);
        current = openStack.join("");
        hasRealTextSinceLastLine = false;
      }
    }
  }

  SPAN_TOKEN_RE.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPAN_TOKEN_RE.exec(html))) {
    flushText(html.slice(lastIndex, match.index));
    const token = match[0];
    if (token === "</span>") openStack.pop();
    else openStack.push(token);
    current += token; // tag-only text, never sets hasRealTextSinceLastLine
    lastIndex = SPAN_TOKEN_RE.lastIndex;
  }
  flushText(html.slice(lastIndex));
  lines.push(current);

  return withoutTrailingNewlineArtifact(lines, hasRealTextSinceLastLine);
}
