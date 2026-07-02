import { describe, it, expect, vi, beforeEach } from "vitest";

// list-line's depth walker is a pure syntax-tree query, but building a real
// tree needs the markdown extension — mount through the editor like
// list-indent.test.ts does, and stub Tauri's invoke with the real contracts.
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

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { mountEditor } from "../src/editor";
import { listItemDepth } from "../src/markdown/live-preview/features/list-line";

/** Resolve the ListItem node that begins on `lineNumber` (1-based) — walk up
 *  from the line's inner node to the nearest ListItem whose own first line is
 *  this line (same ancestor-walk shape as fold.ts's `listRange`). Resolves at
 *  the line's first non-whitespace column, not column 0: an indented nested
 *  item's ListItem range starts after its leading indent, so resolving at
 *  column 0 would land in the parent item's range instead and never find it. */
function listItemAt(state: EditorState, lineNumber: number): SyntaxNode {
  const line = state.doc.line(lineNumber);
  const firstNonWs = line.text.match(/\S/)?.index ?? 0;
  const tree = syntaxTree(state);
  for (let n: SyntaxNode | null = tree.resolveInner(line.from + firstNonWs, 1); n; n = n.parent) {
    if (n.name === "ListItem" && state.doc.lineAt(n.from).number === line.number) return n;
  }
  throw new Error(`no ListItem found on line ${lineNumber}`);
}

describe("listItemDepth: pure query", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("top-level bullet item is depth 1", () => {
    const view = mountEditor(host, "- a", "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    expect(listItemDepth(listItemAt(view.state, 1))).toBe(1);
    view.destroy();
  });

  it("one level of nesting is depth 2", () => {
    const doc = "- a\n    - b";
    const view = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    expect(listItemDepth(listItemAt(view.state, 1))).toBe(1);
    expect(listItemDepth(listItemAt(view.state, 2))).toBe(2);
    view.destroy();
  });

  it("two levels of nesting is depth 3", () => {
    const doc = "- a\n    - b\n        - c";
    const view = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    expect(listItemDepth(listItemAt(view.state, 1))).toBe(1);
    expect(listItemDepth(listItemAt(view.state, 2))).toBe(2);
    expect(listItemDepth(listItemAt(view.state, 3))).toBe(3);
    view.destroy();
  });

  it("ordered lists nest the same way as bullet lists", () => {
    const doc = "1. a\n    1. b";
    const view = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    expect(listItemDepth(listItemAt(view.state, 1))).toBe(1);
    expect(listItemDepth(listItemAt(view.state, 2))).toBe(2);
    view.destroy();
  });

  it("task items nest the same way (still ListItem)", () => {
    const doc = "- [ ] a\n    - [x] b";
    const view = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    expect(listItemDepth(listItemAt(view.state, 1))).toBe(1);
    expect(listItemDepth(listItemAt(view.state, 2))).toBe(2);
    view.destroy();
  });

  it("a non-list node has depth 0 (no ListItem ancestor)", () => {
    const doc = "just a paragraph";
    const view = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    const node = syntaxTree(view.state).resolveInner(0, 1);
    expect(listItemDepth(node)).toBe(0);
    view.destroy();
  });
});
