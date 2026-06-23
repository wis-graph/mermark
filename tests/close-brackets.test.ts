import { describe, it, expect, vi, beforeEach } from "vitest";

// closeBrackets fires from the editor's inputHandler facet (the same path CM
// drives on real typing). Stub Tauri's invoke so mountEditor's widgets/autosave
// don't reach a backend; list_link_targets returns an empty list so the
// completion source never interferes with bracket assertions.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "read_file"
      ? Promise.resolve({ text: "", mtime: 1 })
      : cmd === "write_file"
        ? Promise.resolve(1)
        : cmd === "list_link_targets"
          ? Promise.resolve([])
          : Promise.resolve(false),
  ),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

import { EditorView } from "@codemirror/view";
import { mountEditor } from "../src/editor";

/** Simulate a single-character keystroke by driving the editor's inputHandler
 *  facet exactly as CM's DOM observer does: each handler may consume the input
 *  (return true after dispatching) — closeBrackets is one such handler. If none
 *  consume it, fall back to a plain insert so caret movement matches real typing. */
function typeChar(view: EditorView, char: string): void {
  const { from, to } = view.state.selection.main;
  const insert = () =>
    view.state.update({
      changes: { from, to, insert: char },
      selection: { anchor: from + char.length },
      userEvent: "input.type",
    });
  const handlers = view.state.facet(EditorView.inputHandler);
  for (const h of handlers) {
    if (h(view, from, to, char, insert)) return; // consumed (e.g. closeBrackets)
  }
  view.dispatch(insert());
}

function type(view: EditorView, text: string): void {
  for (const ch of text) typeChar(view, ch);
}

function mount(host: HTMLElement, doc: string): EditorView {
  return mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
}

describe("closeBrackets wiring", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("auto-closes [ into [] with the caret inside", () => {
    const view = mount(host, "");
    type(view, "[");
    expect(view.state.doc.toString()).toBe("[]");
    expect(view.state.selection.main.head).toBe(1); // caret between the brackets
    view.destroy();
  });

  it("nests [[ into [[]] (the wikilink trigger)", () => {
    const view = mount(host, "");
    type(view, "[[");
    expect(view.state.doc.toString()).toBe("[[]]");
    expect(view.state.selection.main.head).toBe(2); // caret at [[|]]
    view.destroy();
  });

  it("overtypes the closing ] instead of inserting a duplicate", () => {
    const view = mount(host, "");
    type(view, "["); // -> [|]
    type(view, "]"); // typing ] over the close should pass through, not double
    expect(view.state.doc.toString()).toBe("[]");
    expect(view.state.selection.main.head).toBe(2); // caret after the pair
    view.destroy();
  });

  it("wraps a selection in parentheses", () => {
    const view = mount(host, "word");
    view.dispatch({ selection: { anchor: 0, head: 4 } });
    type(view, "(");
    expect(view.state.doc.toString()).toBe("(word)");
    view.destroy();
  });
});
