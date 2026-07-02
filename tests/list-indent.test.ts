import { describe, it, expect, vi, beforeEach } from "vitest";

// list-indent's popup branch talks to completionStatus/acceptCompletion, which
// live atop the wikilink completion source — so, like wikilink-complete.test.ts,
// stub Tauri's invoke with the real IPC shapes (read_file/write_file/list_link_targets).
const mockInvoke = vi.fn((cmd: string) =>
  cmd === "read_file"
    ? Promise.resolve({ text: "", mtime: 1 })
    : cmd === "write_file"
      ? Promise.resolve(1)
      : cmd === "list_link_targets"
        ? Promise.resolve([{ name: "alpha", rel: "alpha.md", kind: "markdown" }])
        : Promise.resolve(false),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => (mockInvoke as unknown as (...a: unknown[]) => unknown)(...args),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

import { EditorView, keymap } from "@codemirror/view";
import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { mountEditor } from "../src/editor";
import {
  completionPopupIsOpen,
  lineIsListItem,
  selectionOnListLines,
  indentListItem,
  dedentListItem,
  listIndentKeymap,
} from "../src/markdown/list-indent";
import { resetWikilinkCache } from "../src/markdown/wikilink-complete";

function mount(host: HTMLElement, doc: string): EditorView {
  return mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
}

/** Place the cursor (or a selection) and force a synchronous re-measure so the
 *  view's decorations/keymaps reflect the new selection before we assert. */
function setSelection(view: EditorView, anchor: number, head = anchor): void {
  view.dispatch({ selection: { anchor, head } });
}

describe("list-indent: pure queries", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("lineIsListItem: true on a bullet list line", () => {
    const view = mount(host, "- a\n- b");
    expect(lineIsListItem(view.state, view.state.doc.line(2).from)).toBe(true);
  });

  it("lineIsListItem: true on an ordered list line", () => {
    const view = mount(host, "1. a\n2. b");
    expect(lineIsListItem(view.state, view.state.doc.line(2).from)).toBe(true);
  });

  it("lineIsListItem: true on a task-item line", () => {
    const view = mount(host, "- [ ] a\n- [ ] b");
    expect(lineIsListItem(view.state, view.state.doc.line(2).from)).toBe(true);
  });

  it("lineIsListItem: false on a plain paragraph line", () => {
    const view = mount(host, "plain paragraph");
    expect(lineIsListItem(view.state, 0)).toBe(false);
  });

  it("selectionOnListLines: true when every touched line is a list item", () => {
    const view = mount(host, "- a\n- b\n- c");
    const l2 = view.state.doc.line(2);
    const l3 = view.state.doc.line(3);
    setSelection(view, l2.from, l3.to);
    expect(selectionOnListLines(view.state)).toBe(true);
  });

  it("selectionOnListLines: false when selection mixes a list line with a plain line", () => {
    // Blank lines isolate "plain" from CommonMark lazy-continuation (a line
    // glued directly under "- a" with no blank line would parse as part of
    // that same ListItem's paragraph, not as a plain line).
    const view = mount(host, "- a\n\nplain\n\n- c");
    setSelection(view, 0, view.state.doc.length);
    expect(selectionOnListLines(view.state)).toBe(false);
  });

  it("selectionOnListLines: false on an all-plain document (CQS — state unchanged)", () => {
    const view = mount(host, "plain paragraph");
    const before = view.state.doc.toString();
    expect(selectionOnListLines(view.state)).toBe(false);
    expect(view.state.doc.toString()).toBe(before); // pure: no mutation
  });

  it("completionPopupIsOpen: false with no popup open", () => {
    const view = mount(host, "plain text");
    expect(completionPopupIsOpen(view.state)).toBe(false);
  });
});

describe("list-indent: indentListItem / dedentListItem commands", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("bullet Tab: indents the current list line by 4 spaces", () => {
    const view = mount(host, "- a\n- b");
    setSelection(view, view.state.doc.line(2).from);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- a\n    - b");
  });

  it("bullet Shift-Tab: dedents an indented list line", () => {
    const view = mount(host, "- a\n    - b");
    setSelection(view, view.state.doc.line(2).from);
    expect(dedentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- a\n- b");
  });

  it("ordered Tab: indents the current list line by 4 spaces", () => {
    const view = mount(host, "1. a\n2. b");
    setSelection(view, view.state.doc.line(2).from);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("1. a\n    2. b");
  });

  it("ordered Shift-Tab: dedents back", () => {
    const view = mount(host, "1. a\n    2. b");
    setSelection(view, view.state.doc.line(2).from);
    expect(dedentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("1. a\n2. b");
  });

  it("task item Tab: indents by 4 spaces", () => {
    const view = mount(host, "- [ ] a\n- [ ] b");
    setSelection(view, view.state.doc.line(2).from);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- [ ] a\n    - [ ] b");
  });

  it("non-list Tab passes through: returns false, doc unchanged", () => {
    const view = mount(host, "plain paragraph");
    setSelection(view, 3);
    const doc = view.state.doc.toString();
    expect(indentListItem(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("non-list Shift-Tab passes through: returns false, doc unchanged", () => {
    const view = mount(host, "plain paragraph");
    setSelection(view, 3);
    const doc = view.state.doc.toString();
    expect(dedentListItem(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("multi-line list selection: Tab indents every touched line", () => {
    const view = mount(host, "- a\n- b\n- c");
    const l2 = view.state.doc.line(2);
    const l3 = view.state.doc.line(3);
    setSelection(view, l2.from, l3.to);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- a\n    - b\n    - c");
  });

  it("mixed selection (list + plain line) passes through: returns false, doc unchanged", () => {
    const view = mount(host, "- a\n\nplain\n\n- c"); // blank lines: see note above
    setSelection(view, 0, view.state.doc.length);
    const doc = view.state.doc.toString();
    expect(indentListItem(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
    expect(dedentListItem(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe("list-indent: popup takes priority over indent", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    resetWikilinkCache();
    mockInvoke.mockClear();
  });

  it("Tab with an open wikilink popup accepts the completion, not indent", async () => {
    const view = mount(host, "- see [[a");
    setSelection(view, view.state.doc.length);
    startCompletion(view);
    // The completion source is async (invoke("list_link_targets")); poll a few
    // macrotask turns for the popup to reach "active".
    for (let i = 0; i < 20 && completionStatus(view.state) !== "active"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(completionStatus(view.state)).toBe("active");
    expect(completionPopupIsOpen(view.state)).toBe(true);
    // acceptCompletion refuses to fire within completionConfig.interactionDelay
    // (75ms) of the popup opening — wait it out so the accept below is real,
    // not a false negative from firing too soon after open.
    await new Promise((r) => setTimeout(r, 100));

    expect(indentListItem(view)).toBe(true); // consumed — by acceptCompletion, not indentMore
    expect(view.state.doc.toString()).toBe("- see [[alpha]]"); // completion applied
    expect(view.state.doc.toString()).not.toContain("    - see"); // NOT indented
  });
});

describe("list-indent: keymap wiring", () => {
  it("listIndentKeymap binds Tab/Shift-Tab to indentListItem/dedentListItem", () => {
    expect(listIndentKeymap).toEqual([
      { key: "Tab", run: indentListItem },
      { key: "Shift-Tab", run: dedentListItem },
    ]);
  });

  it("mounted editor's keymap facet carries listIndentKeymap's bindings", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = mount(host, "- a\n- b");
    const bindings = view.state.facet(keymap).flat();
    const tabBinding = bindings.find((b) => b.key === "Tab" && b.run === indentListItem);
    const shiftTabBinding = bindings.find((b) => b.key === "Shift-Tab" && b.run === dedentListItem);
    expect(tabBinding).toBeDefined();
    expect(shiftTabBinding).toBeDefined();
  });
});
