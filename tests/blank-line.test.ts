import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownLang } from "../src/markdown/parser";
import { isBlockGapLine } from "../src/markdown/live-preview/core";
import { inlinePreview } from "../src/markdown/live-preview";

const stateFor = (doc: string) => EditorState.create({ doc, extensions: [markdownLang()] });
const gap = (doc: string, n: number) => isBlockGapLine(stateFor(doc), stateFor(doc).doc.line(n).from);

describe("isBlockGapLine (cm-blank-line rule)", () => {
  it("empty line between paragraphs is a gap", () => expect(gap("a\n\nb", 2)).toBe(true));
  it("whitespace-only line is a gap", () => expect(gap("a\n   \nb", 2)).toBe(true));
  it("non-blank line is not", () => expect(gap("a\n\nb", 3)).toBe(false));
  it("blank line inside a fenced code block keeps full height", () => {
    expect(gap("```ts\nx\n\ny\n```", 3)).toBe(false);
  });
  it("blank line inside front matter / math block is not a gap", () => {
    expect(gap("---\na: 1\n\nb: 2\n---\n\nbody", 3)).toBe(false);
    expect(gap("$$\nx\n\ny\n$$", 3)).toBe(false);
  });
});

describe("cm-blank-line decoration in a mounted editor", () => {
  function mount(doc: string) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({ parent, state: EditorState.create({ doc, extensions: [markdownLang(), inlinePreview("", "")] }) });
  }
  it("tags blank lines, not code-block ones, and typing removes it", () => {
    const v = mount("a\n\n  \nb\n\n```\nx\n\ny\n```");
    const cls = () => [...v.dom.querySelectorAll(".cm-line")].map((l) => l.classList.contains("cm-blank-line"));
    expect(cls().slice(0, 5)).toEqual([false, true, true, false, true]);
    expect(cls()[7]).toBe(false);
    v.dispatch({ changes: { from: 2, insert: "x" } });
    expect(cls()[1]).toBe(false);
    v.destroy();
  });
});
