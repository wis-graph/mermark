// Focused inline-markdown renderer for table cells (and, via the same
// function, settings/panel/version-pane.ts's changelog bullets). Plain string
// → DOM, with no lezer re-instantiation (cold-load is a first-class
// constraint) and no innerHTML (XSS-safe — every node is built via
// createElement/textContent).
//
// First-pass marks (by design): bold (** / __), italic (* / _), inline code
// (`), strikethrough (~~), links (`[label](url)` / `[[target|alias]]` / bare
// `https://…`), and backslash escapes (\*, \`, \|, …). Code spans disable
// every other mark inside them. One level of nesting is supported (e.g.
// **`x`**, or a bold run inside a link label); highlight/math are out of scope.

import { isExternalUrl, openExternal } from "./open-external";

type Span = { node: Node };

/** A backslash escape: `\x` → literal `x` (markdown only escapes punctuation). */
function unescapeText(text: string): string {
  return text.replace(/\\([\\`*_~|{}\[\]()#+\-.!>])/g, "$1");
}

function textNode(text: string): Text {
  return document.createTextNode(unescapeText(text));
}

/** Find the next unescaped occurrence of `marker` at or after `from`. */
function findMarker(text: string, marker: string, from: number): number {
  for (let i = from; i <= text.length - marker.length; i++) {
    if (text[i - 1] === "\\") continue; // escaped opener → not a marker
    if (text.startsWith(marker, i)) return i;
  }
  return -1;
}

interface LinkToken {
  /** Raw label text (re-rendered recursively — a link label may itself carry
   *  bold/em/code marks). */
  label: string;
  /** Raw href/target, unresolved — a wikilink target, a URL, or a relative
   *  path. Whether it's safe/openable is decided by `isExternalUrl`, not here. */
  href: string;
  /** Offset just past the token in `text`. */
  end: number;
}

/** `[[target]]` / `[[target|alias]]` starting at `i` (`text[i..i+1] === "[["`). */
function matchWikilinkToken(text: string, i: number): LinkToken | null {
  const close = text.indexOf("]]", i + 2);
  if (close < 0) return null;
  const inner = text.slice(i + 2, close);
  if (!inner.trim()) return null;
  const pipe = inner.indexOf("|");
  const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  const alias = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim();
  if (!target) return null;
  return { label: alias || target, href: target, end: close + 2 };
}

/** `[label](url)` starting at `i` (`text[i] === "["`). The `(url)` part is
 *  scanned with paren-depth balancing (not `findMarker`) — a raw URL may
 *  itself contain parens (e.g. `javascript:alert(1)`), and truncating at the
 *  first `)` would misparse the href rather than just fail closed. */
function matchMdLinkToken(text: string, i: number): LinkToken | null {
  const closeBracket = findMarker(text, "]", i + 1);
  if (closeBracket < 0 || text[closeBracket + 1] !== "(") return null;
  const openParen = closeBracket + 1;
  let depth = 1;
  let j = openParen + 1;
  for (; j < text.length; j++) {
    if (text[j - 1] === "\\") continue;
    if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) break;
  }
  if (depth !== 0) return null; // unterminated
  const label = text.slice(i + 1, closeBracket);
  const href = text.slice(openParen + 1, j).trim();
  if (!href) return null;
  return { label, href, end: j + 1 };
}

const BARE_URL_RE = /^https?:\/\/[^\s<>()[\]]+/i;

/** A bare `https?://…` run starting at `i`, guarded so it doesn't fire
 *  mid-word (e.g. the tail of `xhttps://…`). */
function matchBareUrlToken(text: string, i: number): LinkToken | null {
  if (/\w/.test(text[i - 1] ?? "")) return null;
  const m = BARE_URL_RE.exec(text.slice(i));
  if (!m) return null;
  return { label: m[0], href: m[0], end: i + m[0].length };
}

/** Recognize a link-shaped token at `i`: `[[wikilink]]`, `[label](url)`, or a
 *  bare URL. Pure query — returns the label/href/end, or null if nothing
 *  link-shaped starts here. The single dispatch point for G's three token
 *  shapes, so the scan loop doesn't need to know their internals. */
function matchLinkToken(text: string, i: number): LinkToken | null {
  if (text[i] === "[" && text[i + 1] === "[") return matchWikilinkToken(text, i);
  if (text[i] === "[") return matchMdLinkToken(text, i);
  if (text[i] === "h" || text[i] === "H") return matchBareUrlToken(text, i);
  return null;
}

/** True for the gesture that should actually activate a link: the primary
 *  mouse button with no Alt modifier. Right-click (button 2) must still open
 *  the browser's context menu and middle-click (button 1) must do nothing —
 *  neither is "open this link". Alt+click is the app-wide "reveal/edit
 *  source" gesture (see wikilink.ts's `attachAltClickEdit`), so it must fall
 *  through instead of being swallowed here. Pure query. */
function isPlainLeftClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.altKey;
}

/** Build the `<a class="cm-link">` DOM for a matched link token. The label is
 *  re-rendered through `renderSpans` with link-detection turned OFF for that
 *  inner pass — one level of *mark* nesting (bold/em/code/strike), same as
 *  every other mark, but NOT another level of link tokens: a bare-URL
 *  token's label IS its href, so recursing with links still on would just
 *  re-match the same text and recurse forever. `data-href`/`title` — and
 *  therefore the click-to-open handler — are attached ONLY when
 *  `isExternalUrl(href)` passes (the shared contract with features/link.ts,
 *  features/autolink.ts and WikilinkWidget): an internal target (a wikilink
 *  note, a relative path, or a disallowed scheme) renders as link-styled text
 *  with no click handler, so the click falls through to the surrounding
 *  block's existing entry behavior instead of silently doing nothing. `title`
 *  mirrors `href` so the destination is hover-checkable before clicking —
 *  this renderer also draws remote strings (updater-manifest release notes
 *  via version-pane.ts), so a label/destination mismatch must be visible
 *  without a click. No `href` attribute is ever set — that would let the
 *  webview navigate directly. */
function buildLinkAnchor({ label, href }: LinkToken): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "cm-link";
  for (const span of renderSpans(label, false)) a.appendChild(span.node);
  if (isExternalUrl(href)) {
    a.dataset.href = href;
    a.title = href;
    a.addEventListener("mousedown", (e) => {
      if (!isPlainLeftClick(e)) return; // right/middle-click, Alt+click: pass through untouched
      e.preventDefault();
      void openExternal(href, a);
    });
  }
  return a;
}

interface Rule {
  marker: string;
  tag: string;
  cls: string;
  /** Whether child content is itself rendered (false for code spans). */
  recurse: boolean;
}

// Order matters: code first (it disables inner marks), then strong before em so
// `**` is consumed before a single `*`.
const RULES: Rule[] = [
  { marker: "`", tag: "code", cls: "cm-inline-code", recurse: false },
  { marker: "**", tag: "strong", cls: "cm-strong", recurse: true },
  { marker: "__", tag: "strong", cls: "cm-strong", recurse: true },
  { marker: "~~", tag: "del", cls: "cm-strike", recurse: true },
  { marker: "*", tag: "em", cls: "cm-em", recurse: true },
  { marker: "_", tag: "em", cls: "cm-em", recurse: true },
];

/** Tokenize `text` into a flat list of DOM nodes, applying the first matching
 *  mark rule and recursing into its body (one rule deeper). `allowLinks`
 *  gates link-token detection (on for the top-level cell/bullet text and for
 *  a mark's body, off for a link's own label — see `buildLinkAnchor`). */
function renderSpans(text: string, allowLinks = true): Span[] {
  const out: Span[] = [];
  let i = 0;
  let plainStart = 0;
  const flushPlain = (end: number) => {
    if (end > plainStart) out.push({ node: textNode(text.slice(plainStart, end)) });
  };

  while (i < text.length) {
    if (allowLinks && text[i - 1] !== "\\") {
      const link = matchLinkToken(text, i);
      if (link) {
        flushPlain(i);
        out.push({ node: buildLinkAnchor(link) });
        i = link.end;
        plainStart = i;
        continue;
      }
    }
    let matched = false;
    for (const rule of RULES) {
      if (text[i - 1] === "\\") break; // escaped → treat as plain
      if (!text.startsWith(rule.marker, i)) continue;
      const close = findMarker(text, rule.marker, i + rule.marker.length);
      if (close < 0) continue; // no closer → not a mark, keep scanning rules
      const body = text.slice(i + rule.marker.length, close);
      if (body.length === 0) continue; // empty span (e.g. ****) → plain
      flushPlain(i);
      const el = document.createElement(rule.tag);
      el.className = rule.cls;
      if (rule.recurse) {
        for (const span of renderSpans(body, allowLinks)) el.appendChild(span.node);
      } else {
        el.textContent = body; // code: literal, no escapes processed
      }
      out.push({ node: el });
      i = close + rule.marker.length;
      plainStart = i;
      matched = true;
      break;
    }
    if (!matched) i++;
  }
  flushPlain(text.length);
  return out;
}

/** Render a single table cell's inline markdown to a DocumentFragment.
 *  Pure query — no side effects (CQS). XSS-safe (no innerHTML). */
export function renderInlineMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const { node } of renderSpans(text)) frag.appendChild(node);
  return frag;
}
