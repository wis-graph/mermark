// Pure transform layer for the HTML viewer (R11 2단계, _workspace/01_html_viewer.md
// §5). Every function here is a pure QUERY — no DOM globals beyond the
// standard, script-inert `DOMParser`/`TextDecoder` (both spec-guaranteed not
// to execute embedded scripts — DOMParser's HTML parsing algorithm never
// evaluates <script>, and TextDecoder is a byte→string codec with no parsing
// at all), no IO, no fetch. This is what lets vitest exercise them directly
// with no jsdom/editor mount and no `../../api` facade involvement — the
// facade only carries STATEFUL registries (viewer registry, settings), never
// pure helpers like these (design §5's own framing: "순수 query — DOM
// 전역·IO 부수효과 0").
//
// This module does NOT sanitize (design §3.5 — sandbox is the sole defense
// layer, DOMPurify would only degrade fidelity without adding safety). A
// <script> tag entering `rewriteRelativeSrcAttrs` comes out unchanged — that
// is the explicit contract this file's tests assert (TDD RED-1, design §7
// step 1), not an oversight.

/** Sniff the *declared* character encoding from an HTML document's own head
 *  bytes — `<meta charset="...">` or the legacy `<meta http-equiv="Content-Type"
 *  content="...charset=...">` form — scanning only `headBytes` (design: "선두
 *  1024바이트"). Bytes are read as raw ASCII code points (never decoded as
 *  UTF-8/etc. first) because the whole point is to find the encoding BEFORE
 *  committing to one, and every encoding this function needs to detect
 *  (utf-8, euc-kr, iso-8859-1, ...) agrees on the ASCII range the `<meta>` tag
 *  itself is written in. Falls back to "utf-8" when no declaration is found —
 *  matches the HTML spec's own default and this codebase's existing
 *  UTF-8-first convention. Pure query. */
export function sniffDeclaredCharset(headBytes: Uint8Array): string {
  let ascii = "";
  for (let i = 0; i < headBytes.length; i += 1) ascii += String.fromCharCode(headBytes[i]);

  const metaCharset = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_-]+)/i.exec(ascii);
  if (metaCharset) return metaCharset[1].toLowerCase();

  const httpEquiv =
    /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9_-]+)/i.exec(
      ascii,
    );
  if (httpEquiv) return httpEquiv[1].toLowerCase();

  return "utf-8";
}

/** The single "how many head bytes does the charset sniff look at" constant —
 *  named so `decodeHtmlBytes` and any test fixture agree on the same window
 *  without a magic number duplicated between them. */
const CHARSET_SNIFF_WINDOW = 1024;

/** Decode a raw HTML file's bytes into a string, using whatever encoding
 *  `sniffDeclaredCharset` finds in the head (design: 구형 .html의 EUC-KR 등
 *  구형 인코딩 현실 대응). `TextDecoder` throws a `RangeError` on a label it
 *  doesn't recognize (a typo'd charset, or one the runtime's ICU data lacks)
 *  — that failure falls back to utf-8 rather than propagating, since a wrong
 *  guess should degrade gracefully to "renders with some mojibake" rather
 *  than "the viewer can't open the file at all". Command-shaped only insofar
 *  as `TextDecoder` is a platform object; no IO, no external state read. */
export function decodeHtmlBytes(bytes: ArrayBuffer): string {
  const head = new Uint8Array(bytes.slice(0, Math.min(CHARSET_SNIFF_WINDOW, bytes.byteLength)));
  const charset = sniffDeclaredCharset(head);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Tag names whose `src` attribute this rewrite touches — the exact set
 *  design §3.4/§5 names (`img, source, video, audio`). `srcset` is explicitly
 *  OUT of scope (design §9 — no picture-density rewriting), and so is any
 *  other attribute (`href` on `<a>`/`<link>` is a DELIBERATE non-rewrite: the
 *  design accepts relative CSS `<link>` as a documented limitation rather
 *  than silently "fixing" it in a way nothing announces, §3.4). */
const REWRITTEN_TAGS = ["img", "source", "video", "audio"] as const;

/** The "is this src value something we should leave alone" rule (design
 *  §3.4): an absolute URL with a scheme (`http:`, `https:`, `data:`, ...), a
 *  protocol-relative URL (`//host/...`), a fragment-only reference (`#...`),
 *  or a root-relative path (`/...` — ambiguous without a known site root, so
 *  left untouched rather than guessed at) are never rewritten. Everything
 *  else (`chart.png`, `./chart.png`, `images/chart.png`) is a same-directory
 *  or subdirectory relative reference and IS rewritten. Pure query — the
 *  single place this classification is made, so the rewrite loop below never
 *  re-derives it inline (named-function-over-inline-if, CLAUDE.md). */
function isRelativeAssetUrl(src: string): boolean {
  if (src === "") return false;
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(src);
}

/** Join a directory (already absolute) with a relative reference, stripping a
 *  leading `./` — the one place `dirAbsPath + "/" + rel` concatenation
 *  happens, so `rewriteRelativeSrcAttrs` never repeats the string-join rule
 *  inline per element. `..` traversal is intentionally NOT resolved (design
 *  §9 scope: this function only needs to handle the common "sibling asset"
 *  case; a `../`-climbing reference is rare enough in a standalone .html
 *  export that resolving it correctly isn't worth the path-normalization
 *  code — `toAssetUrl`'s caller, `convertFileSrc`, just gets a slightly odd
 *  but harmless path string in that rare case). Pure query. */
function joinDirAndRelative(dirAbsPath: string, rel: string): string {
  const stripped = rel.startsWith("./") ? rel.slice(2) : rel;
  return dirAbsPath === "" ? stripped : `${dirAbsPath}/${stripped}`;
}

/** Rewrite every relative `img/source/video/audio` `src` in `html` to an
 *  absolute asset URL via `toAssetUrl` (design §3.4 — `<base>` injection is
 *  rejected because the inherited `base-uri 'self'` CSP blocks it; this
 *  one-time rewrite is the adopted alternative). Parses with `DOMParser` —
 *  standard-guaranteed script-inert (embedded `<script>` elements are parsed
 *  as inert DOM nodes, never executed, and this function does not strip them
 *  either: sanitize is explicitly NOT this function's job, design §3.5) —
 *  then serializes the mutated tree back to a string for `srcdoc` assignment.
 *  `toAssetUrl` is injected (not a direct `convertFileSrc` import) so this
 *  stays a pure function testable with an identity stub, and so the ONE
 *  real-`convertFileSrc` call site is the viewer's own `index.ts` (design
 *  §5). Pure query — parses/serializes text in, text out, no external state
 *  touched, no fetch. */
export function rewriteRelativeSrcAttrs(
  html: string,
  dirAbsPath: string,
  toAssetUrl: (absPath: string) => string,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const tag of REWRITTEN_TAGS) {
    for (const el of Array.from(doc.querySelectorAll(tag))) {
      const src = el.getAttribute("src");
      if (src != null && isRelativeAssetUrl(src)) {
        el.setAttribute("src", toAssetUrl(joinDirAndRelative(dirAbsPath, src)));
      }
    }
  }
  return doc.documentElement.outerHTML;
}
