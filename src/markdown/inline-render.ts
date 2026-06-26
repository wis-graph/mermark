// Focused inline-markdown renderer for table cells. Plain string → DOM, with no
// lezer re-instantiation (cold-load is a first-class constraint) and no
// innerHTML (XSS-safe — every node is built via createElement/textContent).
//
// First-pass marks (by design): bold (** / __), italic (* / _), inline code
// (`), strikethrough (~~), and backslash escapes (\*, \`, \|, …). Code spans
// disable every other mark inside them. One level of nesting is supported
// (e.g. **`x`**); link/wikilink/highlight/math are out of scope.

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
 *  mark rule and recursing into its body (one rule deeper). */
function renderSpans(text: string): Span[] {
  const out: Span[] = [];
  let i = 0;
  let plainStart = 0;
  const flushPlain = (end: number) => {
    if (end > plainStart) out.push({ node: textNode(text.slice(plainStart, end)) });
  };

  while (i < text.length) {
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
        for (const span of renderSpans(body)) el.appendChild(span.node);
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
