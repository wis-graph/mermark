import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import type { BlockContext, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";

// ---------------------------------------------------------------------------
// Custom syntax as real Lezer nodes so every decorator works off the parse
// tree (code fences, blockquotes, and overlap rules come for free).
// ---------------------------------------------------------------------------

const BRACKET_L = 91; // [
const BRACKET_R = 93; // ]
const BANG = 33; // !
const PIPE = 124; // |
const DOLLAR = 36; // $
const EQUALS = 61; // =
const CARET = 94; // ^
const NEWLINE = 10;
const SPACE = 32;
const TAB = 9;
const BACKSLASH = 92;

/** [[target]], [[target|alias]], ![[embed]] — parsed before Link/Image. */
const wikilinkExt: MarkdownConfig = {
  defineNodes: [
    { name: "Wikilink" },
    { name: "WikilinkEmbed" },
    { name: "WikilinkMark" },
    { name: "WikilinkTarget" },
    { name: "WikilinkAlias" },
  ],
  parseInline: [
    {
      name: "Wikilink",
      before: "Link",
      parse(cx: InlineContext, next: number, pos: number): number {
        let embed = false;
        if (next === BANG && cx.char(pos + 1) === BRACKET_L && cx.char(pos + 2) === BRACKET_L) {
          embed = true;
        } else if (next !== BRACKET_L || cx.char(pos + 1) !== BRACKET_L) {
          return -1;
        }
        const open = pos + (embed ? 3 : 2);
        let pipe = -1;
        let close = -1;
        for (let i = open; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === NEWLINE || ch === BRACKET_L) return -1;
          if (ch === PIPE && pipe < 0) pipe = i;
          if (ch === BRACKET_R) {
            if (cx.char(i + 1) === BRACKET_R) close = i;
            break;
          }
        }
        if (close < 0 || close === open) return -1;
        const children = [cx.elt("WikilinkMark", pos, open)];
        if (pipe >= 0 && pipe < close) {
          children.push(cx.elt("WikilinkTarget", open, pipe));
          children.push(cx.elt("WikilinkMark", pipe, pipe + 1));
          children.push(cx.elt("WikilinkAlias", pipe + 1, close));
        } else {
          children.push(cx.elt("WikilinkTarget", open, close));
        }
        children.push(cx.elt("WikilinkMark", close, close + 2));
        return cx.addElement(cx.elt(embed ? "WikilinkEmbed" : "Wikilink", pos, close + 2, children));
      },
    },
  ],
};

/**
 * Inline $…$ with pandoc-style guards: the opener must be followed by a
 * non-space, the closer preceded by a non-space and not followed by a digit.
 * `$5 and $10` therefore stays plain text.
 */
const inlineMathExt: MarkdownConfig = {
  defineNodes: [{ name: "InlineMath" }, { name: "MathMark" }],
  parseInline: [
    {
      name: "InlineMath",
      before: "Link",
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== DOLLAR) return -1;
        if (cx.char(pos + 1) === DOLLAR || cx.char(pos - 1) === DOLLAR) return -1;
        const first = cx.char(pos + 1);
        if (first === SPACE || first === TAB || first < 0) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === NEWLINE) return -1;
          if (ch !== DOLLAR) continue;
          const prev = cx.char(i - 1);
          if (prev === SPACE || prev === TAB || prev === BACKSLASH) continue;
          const after = cx.char(i + 1);
          if (after >= 48 && after <= 57) continue; // digit after closer → currency, not math
          if (after === DOLLAR) continue;
          return cx.addElement(
            cx.elt("InlineMath", pos, i + 1, [
              cx.elt("MathMark", pos, pos + 1),
              cx.elt("MathMark", i, i + 1),
            ]),
          );
        }
        return -1;
      },
    },
  ],
};

/**
 * Display math: a line starting with $$ opens a block that runs to the next
 * line ending with $$ (or end of document, like an unclosed code fence).
 * `$$` mid-sentence never opens a block.
 */
const blockMathExt: MarkdownConfig = {
  defineNodes: [{ name: "BlockMath", block: true }],
  parseBlock: [
    {
      name: "BlockMath",
      parse(cx: BlockContext, line: Line): boolean {
        if (line.next !== DOLLAR || line.text.charCodeAt(line.pos + 1) !== DOLLAR) return false;
        const from = cx.lineStart + line.pos;
        const tail = line.text.slice(line.pos + 2);
        const closeIdx = tail.indexOf("$$");
        if (closeIdx >= 0 && tail.slice(0, closeIdx).trim()) {
          // one-liner: $$x^2$$
          cx.addElement(cx.elt("BlockMath", from, cx.lineStart + line.pos + 2 + closeIdx + 2));
          cx.nextLine();
          return true;
        }
        let to = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          to = cx.lineStart + line.text.length;
          if (/\$\$\s*$/.test(line.text)) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("BlockMath", from, to));
        return true;
      },
    },
  ],
};

/** [^ref] footnote references (definitions are detected in the decorator). */
const footnoteExt: MarkdownConfig = {
  defineNodes: [{ name: "FootnoteRef" }],
  parseInline: [
    {
      name: "FootnoteRef",
      before: "Link",
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== BRACKET_L || cx.char(pos + 1) !== CARET) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === NEWLINE || ch === BRACKET_L || ch === SPACE) return -1;
          if (ch === BRACKET_R) {
            if (i === pos + 2) return -1;
            return cx.addElement(cx.elt("FootnoteRef", pos, i + 1));
          }
        }
        return -1;
      },
    },
  ],
};

/**
 * ==highlight== — the `==` twin of GFM Strikethrough (which `@lezer/markdown`'s
 * GFM only defines for `~~`). Guards mirror inline math so prose stays plain:
 * the opener must be a `==` pair followed by a non-space (so `a == b` and the
 * triple `===` never open), the body must be non-empty and on one line (no
 * newline crossing). Tree-based, so code fences / inline code disable it for
 * free. Split into open/close HighlightMark children so the decorator can
 * conceal just the markers.
 */
const highlightExt: MarkdownConfig = {
  defineNodes: [{ name: "Highlight" }, { name: "HighlightMark" }],
  parseInline: [
    {
      name: "Highlight",
      before: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number): number {
        // opener: exactly a `==` pair (a 3rd `=` → `===`, treated as not a mark)
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS) return -1;
        if (cx.char(pos + 2) === EQUALS) return -1;
        // opener must be followed by a non-space → `a == b` stays prose
        const first = cx.char(pos + 2);
        if (first === SPACE || first === TAB || first === NEWLINE || first < 0) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === NEWLINE) return -1; // inline only — never cross a line
          if (ch !== EQUALS || cx.char(i + 1) !== EQUALS) continue;
          const prev = cx.char(i - 1); // closer must be preceded by a non-space (symmetry)
          if (prev === SPACE || prev === TAB) continue;
          return cx.addElement(
            cx.elt("Highlight", pos, i + 2, [
              cx.elt("HighlightMark", pos, pos + 2),
              cx.elt("HighlightMark", i, i + 2),
            ]),
          );
        }
        return -1;
      },
    },
  ],
};

export const mermarkExtensions: MarkdownConfig[] = [
  wikilinkExt,
  inlineMathExt,
  blockMathExt,
  footnoteExt,
  highlightExt,
];

/** Markdown language: GFM (tables/strikethrough/tasklists) + mermark syntax. */
export function markdownLang() {
  return markdown({ extensions: [GFM, ...mermarkExtensions] });
}
