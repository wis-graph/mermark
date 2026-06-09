import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";

export interface WikilinkHit {
  from: number;
  to: number;
  target: string;
  alias: string;
}

const RE = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;

/** Find all [[wikilink]] spans in one line. Offsets are absolute (line start + base). */
export function scanWikilinks(line: string, base: number): WikilinkHit[] {
  const out: WikilinkHit[] = [];
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(line))) {
    const target = m[1].trim();
    out.push({
      from: base + m.index,
      to: base + m.index + m[0].length,
      target,
      alias: (m[2] ?? target).trim(),
    });
  }
  return out;
}

/** The markdown language config used by the editor (GFM tables/strikethrough/tasklists). */
export function markdownLang() {
  return markdown({ extensions: [GFM] });
}
