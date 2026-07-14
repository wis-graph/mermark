import { describe, it, expect, vi, beforeEach } from "vitest";

// Same Tauri stub as render-smoke.test.ts — autosave/image/wikilink widgets call
// invoke; contract: read_file -> {text, mtime}, write_file -> mtime.
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

import { WidgetType } from "@codemirror/view";
import { foldedRanges, foldCode } from "@codemirror/language";
import { undo, undoDepth } from "@codemirror/commands";
import { mountEditor } from "../src/editor";
import { registerBlockFeature } from "../src/markdown/live-preview/feature-registry";
import type { BlockFeature } from "../src/markdown/live-preview/core";

// Stage B-3 (design §3.4/plan §Stage B-3): a feature registered AFTER an
// editor is already open must reach that open editor via reloadFeatures(),
// and the reconfigure transaction must be doc-free — cursor, undo history,
// fold state, vim/mode, and autosave all live outside featureCompartment, so
// this test locks the preservation claim in place rather than just trusting
// the design argument.

class TestBlockWidget extends WidgetType {
  toDOM() {
    const d = document.createElement("div");
    d.className = "cm-testblock";
    return d;
  }
  eq() {
    return true;
  }
}

// Claims BulletList — no shipped block feature claims this node (only the
// inline `list`/`listLine` features touch bullet lines), so it's a clean late
// registration that doesn't collide with any built-in under first-claim-wins.
const testFeature: BlockFeature = {
  nodes: ["BulletList"],
  match: (node) => ({
    kind: "test",
    from: node.from,
    to: node.to,
    src: "",
    widget: () => new TestBlockWidget(),
  }),
};

// A second same-level heading bounds the fold to JUST the body under
// "# Heading" (headingRange in markdown/fold.ts folds to the next heading of
// the same or higher level, or to the doc end if there is none) — the cursor
// position P below and the table/list must stay OUTSIDE the folded range, or
// CM6's own "don't hide the cursor" fold-clearing kicks in and this test
// would be asserting something other than what it claims (preservation across
// reloadFeatures, not preservation across an unrelated auto-unfold).
const DOC = [
  "# Heading",
  "",
  "folded body line",
  "",
  "# Second",
  "",
  "intro paragraph HERE more text",
  "",
  "| A | B |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "- item one",
  "- item two",
  "",
].join("\n");

describe("feature-reload: late registration reaches an already-open editor", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("registerBlockFeature + reloadFeatures() renders the new widget while preserving cursor, undo, fold state", () => {
    const P = DOC.indexOf("HERE");
    const ed = mountEditor(host, DOC, "/tmp", "/tmp/doc.md", { initialMode: "edit" });
    const view = ed.view;

    // Fold the heading (foldService in markdownFolding) before any registry change.
    view.dispatch({ selection: { anchor: 1 } }); // caret on "# Heading" line
    expect(foldCode(view)).toBe(true);
    (view as unknown as { measure(): void }).measure();
    expect(foldedRanges(view.state).size).toBeGreaterThan(0);

    // Make an edit so undo history has something to unwind, then place the
    // caret at P (the position whose preservation this test asserts).
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    expect(undoDepth(view.state)).toBeGreaterThan(0);
    view.dispatch({ selection: { anchor: P } });
    (view as unknown as { measure(): void }).measure();

    // Sanity before registration: no test widget, existing table widget present,
    // fold still holding.
    expect(view.contentDOM.querySelector(".cm-testblock")).toBeNull();
    expect(view.contentDOM.querySelector(".cm-table")).not.toBeNull();
    expect(foldedRanges(view.state).size).toBeGreaterThan(0);

    const unregister = registerBlockFeature(testFeature);
    ed.reloadFeatures();
    (view as unknown as { measure(): void }).measure();

    // 1. new widget appeared
    expect(view.contentDOM.querySelector(".cm-testblock")).not.toBeNull();
    // 2. cursor preserved
    expect(view.state.selection.main.head).toBe(P);
    // 3. existing widget (table) still renders — StateField recomputed, not lost
    expect(view.contentDOM.querySelector(".cm-table")).not.toBeNull();
    // 4. fold state preserved (compartment swap didn't touch markdownFolding's field)
    expect(foldedRanges(view.state).size).toBeGreaterThan(0);
    // 5. undo history preserved — the depth survived the compartment swap
    // (history() lives outside featureCompartment — editor.ts:357/design §3.4)
    expect(undoDepth(view.state)).toBeGreaterThan(0);

    // unregister + reload → widget disappears, cursor still preserved. No
    // further explicit measure() here: jsdom's fake layout throws inside CM's
    // internal measureTextSize heuristic when it runs right after a content
    // resize (a jsdom/CM6 environment limitation unrelated to reloadFeatures —
    // decorations already reflect synchronously in contentDOM on dispatch, so
    // the querySelector checks below don't need a forced measure).
    unregister();
    ed.reloadFeatures();
    expect(view.contentDOM.querySelector(".cm-testblock")).toBeNull();
    expect(view.state.selection.main.head).toBe(P);

    // undo() still works post-reload (exercises the actual mechanism, not
    // just the depth counter) — checked last, own dispatch, no trailing
    // measure() call.
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString().endsWith("x")).toBe(false);

    view.destroy();
  });

  it("reveal 3-stage works on the newly-registered widget (conceal → reveal → re-conceal)", () => {
    const ed = mountEditor(host, DOC, "/tmp", "/tmp/doc.md", { initialMode: "edit" });
    const view = ed.view;
    view.dispatch({ selection: { anchor: 0 } }); // caret far from the list

    const unregister = registerBlockFeature(testFeature);
    ed.reloadFeatures();
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-testblock")).not.toBeNull(); // concealed → widget

    const listPos = DOC.indexOf("- item one") + 1;
    view.dispatch({ selection: { anchor: listPos } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-testblock")).toBeNull(); // revealed → raw source
    expect(view.contentDOM.textContent).toContain("item one");

    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-testblock")).not.toBeNull(); // re-concealed

    unregister();
    view.destroy();
  });
});
