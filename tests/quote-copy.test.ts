import { describe, it, expect, beforeEach, vi } from "vitest";

// Building a real Blockquote node needs the markdown extension — mount
// through the editor like list-depth.test.ts does, and stub Tauri's invoke
// with the real contracts.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "read_file"
      ? Promise.resolve({ text: "", mtime: 1 })
      : cmd === "write_file"
        ? Promise.resolve(1)
        : Promise.resolve(false),
  ),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { mountEditor } from "../src/editor";
import { quoteClipboardText, isTopLevelQuote, quoteRunHead, dropCalloutHead } from "../src/markdown/quote-copy";

function fullTree(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, 5000) ?? syntaxTree(state);
}

/** Every Blockquote node in the doc, outermost-first (document order, and a
 *  parent always precedes its nested children in a top-down walk). */
function blockquotes(state: EditorState): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  fullTree(state).iterate({
    enter(node) {
      if (node.name === "Blockquote") out.push(node.node);
    },
  });
  return out;
}

describe("dropCalloutHead", () => {
  it("drops a recognized callout head line", () => {
    expect(dropCalloutHead(["[!note] Title", "body"])).toEqual(["body"]);
  });
  it("leaves lines alone when the first isn't a callout head", () => {
    expect(dropCalloutHead(["a", "b"])).toEqual(["a", "b"]);
  });
  it("handles an empty list", () => {
    expect(dropCalloutHead([])).toEqual([]);
  });
});

describe("quoteClipboardText / isTopLevelQuote", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("single-level quote: strips exactly one leading `> ` per line", () => {
    const doc = "> a\n> b";
    const view = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    const [q] = blockquotes(view.state);
    expect(quoteClipboardText(view.state, q)).toBe("a\nb");
    expect(isTopLevelQuote(q)).toBe(true);
    view.destroy();
  });

  it("nested `>>` keeps one inner `> ` marker (only one layer removed)", () => {
    const doc = "> a\n> > inner";
    const view = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    const quotes = blockquotes(view.state);
    const outer = quotes.find((q) => isTopLevelQuote(q))!;
    expect(quoteClipboardText(view.state, outer)).toBe("a\n> inner");
    // The nested Blockquote itself is not top-level.
    const inner = quotes.find((q) => q !== outer)!;
    expect(isTopLevelQuote(inner)).toBe(false);
    view.destroy();
  });

  it("an empty `>` line becomes an empty line (paragraph break preserved)", () => {
    const doc = "> a\n>\n> b";
    const view = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    const [q] = blockquotes(view.state);
    expect(quoteClipboardText(view.state, q)).toBe("a\n\nb");
    view.destroy();
  });

  it("a fenced code block inside the quote is preserved verbatim (one layer stripped, content untouched)", () => {
    const doc = "> ```js\n> code();\n> ```";
    const view = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    const [q] = blockquotes(view.state);
    expect(quoteClipboardText(view.state, q)).toBe("```js\ncode();\n```");
    view.destroy();
  });

  it("a callout drops its `[!type] title` head line, keeping only the body", () => {
    const doc = "> [!note] Heads up\n> body line";
    const view = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    const [q] = blockquotes(view.state);
    expect(quoteClipboardText(view.state, q)).toBe("body line");
    view.destroy();
  });
});

describe("quoteRunHead", () => {
  function line(classes: string[]): HTMLElement {
    const el = document.createElement("div");
    el.className = classes.join(" ");
    return el;
  }

  it("returns null for a non-quote line", () => {
    expect(quoteRunHead(line(["cm-line"]))).toBeNull();
  });

  it("returns itself for a single-line run", () => {
    const container = document.createElement("div");
    const a = line(["cm-blockquote"]);
    container.appendChild(a);
    expect(quoteRunHead(a)).toBe(a);
  });

  it("walks back to the first line of a multi-line run", () => {
    const container = document.createElement("div");
    const head = line(["cm-blockquote"]);
    const mid = line(["cm-blockquote"]);
    const tail = line(["cm-blockquote"]);
    container.append(head, mid, tail);
    expect(quoteRunHead(tail)).toBe(head);
    expect(quoteRunHead(mid)).toBe(head);
  });

  it("stops at a non-quote sibling (does not cross into a preceding, unrelated run)", () => {
    const container = document.createElement("div");
    const other = line(["cm-line"]);
    const head = line(["cm-callout", "cm-callout-note"]);
    const tail = line(["cm-callout", "cm-callout-note"]);
    container.append(other, head, tail);
    expect(quoteRunHead(tail)).toBe(head);
  });
});
