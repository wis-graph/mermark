import { describe, it, expect } from "vitest";
import { parser as baseParser } from "@lezer/markdown";
import { GFM } from "@lezer/markdown";
import { mermarkExtensions } from "../src/markdown/parser";

const parser = baseParser.configure([GFM, ...mermarkExtensions]);

/** Parse and return [nodeName, text] pairs for nodes matching `names`. */
function nodesOf(doc: string, ...names: string[]): [string, string][] {
  const tree = parser.parse(doc);
  const out: [string, string][] = [];
  tree.iterate({
    enter(n) {
      if (names.includes(n.name)) out.push([n.name, doc.slice(n.from, n.to)]);
    },
  });
  return out;
}

describe("wikilink parsing", () => {
  it("parses [[target]] as a Wikilink node", () => {
    expect(nodesOf("see [[notes/foo]] now", "Wikilink")).toEqual([["Wikilink", "[[notes/foo]]"]]);
  });
  it("parses alias syntax with Target/Alias children", () => {
    expect(nodesOf("[[a/b|Bee]]", "WikilinkTarget", "WikilinkAlias")).toEqual([
      ["WikilinkTarget", "a/b"],
      ["WikilinkAlias", "Bee"],
    ]);
  });
  it("parses ![[embed]] as WikilinkEmbed, not Image", () => {
    expect(nodesOf("![[pic.png]]", "WikilinkEmbed", "Image")).toEqual([
      ["WikilinkEmbed", "![[pic.png]]"],
    ]);
  });
  it("does NOT parse wikilinks inside code fences", () => {
    expect(nodesOf("```\n[[x]]\n```", "Wikilink")).toEqual([]);
  });
  it("does NOT parse wikilinks inside inline code", () => {
    expect(nodesOf("a `[[x]]` b", "Wikilink")).toEqual([]);
  });
});

describe("inline math parsing", () => {
  it("parses $e=mc^2$", () => {
    expect(nodesOf("Inline $e=mc^2$ here", "InlineMath")).toEqual([["InlineMath", "$e=mc^2$"]]);
  });
  it("leaves currency alone: $5 and $10", () => {
    expect(nodesOf("It costs $5 and $10 total", "InlineMath")).toEqual([]);
  });
  it("does not cross newlines", () => {
    expect(nodesOf("a $x\ny$ b", "InlineMath")).toEqual([]);
  });
  it("ignores math inside code", () => {
    expect(nodesOf("`$x$`", "InlineMath")).toEqual([]);
  });
});

describe("block math parsing", () => {
  it("parses a $$ … $$ block", () => {
    const doc = "before\n\n$$\n\\int_0^1 x\n$$\n\nafter";
    expect(nodesOf(doc, "BlockMath")).toEqual([["BlockMath", "$$\n\\int_0^1 x\n$$"]]);
  });
  it("parses a one-liner $$x^2$$", () => {
    expect(nodesOf("$$x^2$$", "BlockMath")).toEqual([["BlockMath", "$$x^2$$"]]);
  });
  it("does not swallow paragraphs between mid-sentence $$ pairs", () => {
    const doc = "price $$ is high\n\nmiddle paragraph\n\nend $$ here";
    expect(nodesOf(doc, "BlockMath")).toEqual([]);
  });
  it("ignores $$ inside code fences", () => {
    expect(nodesOf("```\n$$\nx\n$$\n```", "BlockMath")).toEqual([]);
  });
  it("works inside blockquotes", () => {
    expect(nodesOf("> $$\n> x^2\n> $$", "BlockMath").length).toBe(1);
  });
});

describe("footnote parsing", () => {
  it("parses [^1] refs", () => {
    expect(nodesOf("Ref[^1] done", "FootnoteRef")).toEqual([["FootnoteRef", "[^1]"]]);
  });
  it("ignores refs in code", () => {
    expect(nodesOf("`[^1]`", "FootnoteRef")).toEqual([]);
  });
});

describe("highlight parsing", () => {
  it("parses ==marked== as a Highlight node", () => {
    expect(nodesOf("a ==marked== b", "Highlight")).toEqual([["Highlight", "==marked=="]]);
  });
  it("splits the opening/closing == into HighlightMark children", () => {
    expect(nodesOf("a ==marked== b", "HighlightMark")).toEqual([
      ["HighlightMark", "=="],
      ["HighlightMark", "=="],
    ]);
  });
  it("does NOT parse highlights inside code fences", () => {
    expect(nodesOf("```\n==x==\n```", "Highlight")).toEqual([]);
  });
  it("does NOT parse highlights inside inline code", () => {
    expect(nodesOf("a `==x==` b", "Highlight")).toEqual([]);
  });
  it("leaves prose comparisons alone: a == b", () => {
    expect(nodesOf("if a == b then", "Highlight")).toEqual([]);
  });
  it("does not treat === (setext-ish / triple) as a highlight", () => {
    expect(nodesOf("x === y", "Highlight")).toEqual([]);
  });
  it("does not cross newlines", () => {
    expect(nodesOf("a ==x\ny== b", "Highlight")).toEqual([]);
  });
  it("rejects empty bodies: ====", () => {
    expect(nodesOf("====", "Highlight")).toEqual([]);
  });
  it("coexists with GFM strikethrough", () => {
    expect(nodesOf("~~struck~~ and ==marked==", "Strikethrough", "Highlight")).toEqual([
      ["Strikethrough", "~~struck~~"],
      ["Highlight", "==marked=="],
    ]);
  });
});

// M7 (CJK-friendly bold) is implemented as a live-preview decoration layer,
// not a parser change — see _workspace/01_architect_design.md §1 for why the
// parser route is structurally blocked. This is the tripwire for that
// premise: if the parser ever starts (or stops) producing StrongEmphasis for
// these cases, the decoration-layer approach's assumptions have shifted and
// cjk-bold.ts needs re-review.
describe("parser invariant: CJK flanking cases (M7 decoration-layer premise)", () => {
  it("still fails to parse **\"New Policy\"**를 as StrongEmphasis (parser untouched)", () => {
    expect(nodesOf('**"New Policy"**를', "StrongEmphasis")).toEqual([]);
  });
  it("still parses plain **bold** as StrongEmphasis", () => {
    expect(nodesOf("**bold**", "StrongEmphasis")).toEqual([["StrongEmphasis", "**bold**"]]);
  });
  it("still parses **중요**를 as StrongEmphasis (CJK letters already flank like letters)", () => {
    expect(nodesOf("**중요**를", "StrongEmphasis")).toEqual([["StrongEmphasis", "**중요**"]]);
  });
});

describe("GFM still intact", () => {
  it("parses tables, task markers, links, images", () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n[t](u) ![a](b.png)";
    expect(nodesOf(doc, "Table").length).toBe(1);
    expect(nodesOf(doc, "TaskMarker").length).toBe(1);
    expect(nodesOf(doc, "Link").length).toBe(1);
    expect(nodesOf(doc, "Image").length).toBe(1);
  });
});

describe("frontmatter parsing (top --- vs mid --- HR)", () => {
  it("parses a top --- … --- block as Frontmatter", () => {
    const doc = "---\ntitle: Hi\ntags: a\n---\nbody";
    const fm = nodesOf(doc, "Frontmatter");
    expect(fm.length).toBe(1);
    expect(fm[0][1]).toBe("---\ntitle: Hi\ntags: a\n---");
  });

  it("leaves a mid-document --- as a HorizontalRule, not Frontmatter", () => {
    const doc = "above\n\n---\n\nbelow";
    expect(nodesOf(doc, "Frontmatter")).toEqual([]);
    expect(nodesOf(doc, "HorizontalRule").length).toBe(1);
  });

  it("does not steal a --- that follows body text from the HR (offset-0 guard)", () => {
    const doc = "intro line\n---\nmore";
    // `---` after a paragraph line is a Setext heading underline, never frontmatter
    expect(nodesOf(doc, "Frontmatter")).toEqual([]);
  });

  it("parses an empty frontmatter ---\\n---", () => {
    const doc = "---\n---\nbody";
    const fm = nodesOf(doc, "Frontmatter");
    expect(fm.length).toBe(1);
    expect(fm[0][1]).toBe("---\n---");
  });

  it("accepts ... as a closing fence", () => {
    const doc = "---\nk: v\n...\nbody";
    const fm = nodesOf(doc, "Frontmatter");
    expect(fm.length).toBe(1);
    expect(fm[0][1]).toBe("---\nk: v\n...");
  });
});

// The 4-space indentUnit decision (src/editor.ts, indentUnit.of("    ")) exists
// because a nested list item must clear its parent's *content column* to parse
// as a nested ListItem rather than a lazy continuation line of the parent's
// paragraph. These assertions are the parser-level evidence for that decision.
describe("list nesting depends on indent width (indentUnit = 4sp decision)", () => {
  it("4-space indent nests a bullet sub-list (BulletList > ListItem > BulletList)", () => {
    const doc = "- a\n    - b";
    const tree = baseParser.configure([GFM, ...mermarkExtensions]).parse(doc);
    let nestedBulletLists = 0;
    tree.iterate({
      enter(n) {
        if (n.name !== "BulletList") return;
        for (let p = n.node.parent; p; p = p.parent) {
          if (p.name === "BulletList") {
            nestedBulletLists++;
            break;
          }
        }
      },
    });
    expect(nestedBulletLists).toBeGreaterThan(0);
  });

  it("4-space indent nests an ordered sub-list (OrderedList > ListItem > OrderedList)", () => {
    const doc = "1. a\n    1. b";
    const tree = baseParser.configure([GFM, ...mermarkExtensions]).parse(doc);
    let nestedOrderedLists = 0;
    tree.iterate({
      enter(n) {
        if (n.name !== "OrderedList") return;
        for (let p = n.node.parent; p; p = p.parent) {
          if (p.name === "OrderedList") {
            nestedOrderedLists++;
            break;
          }
        }
      },
    });
    expect(nestedOrderedLists).toBeGreaterThan(0);
  });

  it("2-space indent does NOT nest an ordered sub-list (lazy continuation instead — why 2sp was rejected)", () => {
    const doc = "1. a\n  1. b";
    const tree = baseParser.configure([GFM, ...mermarkExtensions]).parse(doc);
    let nestedOrderedLists = 0;
    tree.iterate({
      enter(n) {
        if (n.name !== "OrderedList") return;
        for (let p = n.node.parent; p; p = p.parent) {
          if (p.name === "OrderedList") {
            nestedOrderedLists++;
            break;
          }
        }
      },
    });
    expect(nestedOrderedLists).toBe(0);
  });
});
