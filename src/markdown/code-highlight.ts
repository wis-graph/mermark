// Syntax highlighting for fenced code-block widgets. highlight.js is
// dynamic-imported on the FIRST fenced block that names a language — never at
// module load — so it stays out of the initial bundle (cold-load constraint).
// Only hljs's own output (which escapes source text) is ever returned as HTML.
import { boundedCache } from "./bounded-cache";

interface HljsApi {
  getLanguage(name: string): unknown;
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
}

/** Blocks larger than this stay plain: highlighting is synchronous work. */
export const HIGHLIGHT_MAX_CHARS = 20_000;

let hljsPromise: Promise<HljsApi> | null = null;
let hljsReady: HljsApi | null = null;
const htmlCache = boundedCache<string, string[]>(200);

/** Load highlight.js/lib/common once for the process lifetime. Command (memoized). */
export function loadHljs(): Promise<HljsApi> {
  if (!hljsPromise) {
    hljsPromise = import("highlight.js/lib/common").then((m) => {
      hljsReady = m.default as unknown as HljsApi;
      return hljsReady;
    });
  }
  return hljsPromise;
}

/** The fence info string's first word, lowercased ("" for none). Pure query. */
export function fenceLanguageWord(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Is this block worth sending to hljs at all (has a language, not huge)?
 *  Decided BEFORE the import so plain blocks never trigger it. Pure query. */
export function wantsHighlight(lang: string, code: string): boolean {
  return fenceLanguageWord(lang) !== "" && code.length <= HIGHLIGHT_MAX_CHARS;
}

/** Split hljs HTML into one string per source line, re-opening spans that
 *  straddle a line break. Unlike the code viewer's splitter this keeps a
 *  trailing empty line (the widget renders exactly `code.split("\n")` rows).
 *  Pure query. */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = "";
  const flush = (text: string) => {
    const parts = text.split("\n");
    parts.forEach((p, i) => {
      cur += p;
      if (i < parts.length - 1) {
        lines.push(cur + open.map(() => "</span>").join(""));
        cur = open.join("");
      }
    });
  };
  const re = /<span class="[^"]*">|<\/span>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    flush(html.slice(last, m.index));
    if (m[0] === "</span>") open.pop();
    else open.push(m[0]);
    cur += m[0];
    last = re.lastIndex;
  }
  flush(html.slice(last));
  lines.push(cur);
  return lines;
}

function cacheKey(lang: string, code: string): string {
  return `${lang}\u0000${code}`;
}

/** Highlighted per-line HTML if already available WITHOUT loading anything
 *  (cache hit, or hljs already loaded and the language is known); else null.
 *  Pure-ish query (fills the cache). */
export function highlightedLinesNow(lang: string, code: string): string[] | null {
  const word = fenceLanguageWord(lang);
  if (!wantsHighlight(lang, code)) return null;
  const key = cacheKey(word, code);
  const hit = htmlCache.get(key);
  if (hit) return hit;
  if (!hljsReady || !hljsReady.getLanguage(word)) return null;
  const lines = splitHighlightedLines(hljsReady.highlight(code, { language: word, ignoreIllegals: true }).value);
  htmlCache.put(key, lines);
  return lines;
}

/** Load hljs (once) then highlight; resolves null for unknown language /
 *  skipped blocks. Never imports for a block that doesn't want highlighting. */
export async function highlightedLines(lang: string, code: string): Promise<string[] | null> {
  if (!wantsHighlight(lang, code)) return null;
  await loadHljs();
  return highlightedLinesNow(lang, code);
}

/** Test hook: forget the loaded module and cache. Command. */
export function resetCodeHighlightForTests(): void {
  hljsPromise = null;
  hljsReady = null;
  htmlCache.clear();
}
