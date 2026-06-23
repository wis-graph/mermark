import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Tauri's invoke is called by autosave / widgets; stub it with the real command
// contracts: read_file -> {text, mtime}, write_file -> mtime, else -> false.
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

import { mountEditor } from "../src/editor";
import { getCM } from "@replit/codemirror-vim";

// drawSelection() renders the EditorState selection into CM's own
// .cm-selectionLayer overlay. Without it, CM relies on the browser's native DOM
// ::selection, which vim mode kills (hideNativeSelection) while setting
// visual-mode ranges as EditorState selection — leaving the highlight invisible.
// These tests guard that the overlay layer is wired up; a regression that drops
// drawSelection() removes the .cm-selectionLayer node and fails here.
//
// LAYOUT NOTE: jsdom has no layout engine, so the per-range .cm-selectionBackground
// RECTS are never measured/painted (measure() yields empty geometry). We therefore
// assert the overlay LAYER presence + the vim wiring (DOM/config), not the rects.
// The painted rect, its --selection-bg color/contrast in light & dark, and the
// WebKit real-app vim-visual visibility are covered by the golden master + manual.

describe("text-selection rendering (drawSelection)", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  it("mounts the .cm-selectionLayer overlay in edit mode (drawSelection registered)", () => {
    const { view } = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
    });
    // drawSelection() installs a layer view-plugin whose host is .cm-selectionLayer.
    // Absent the extension this node does not exist — this is the core guard.
    expect(view.dom.querySelector(".cm-selectionLayer")).not.toBeNull();
    view.destroy();
  });

  it("keeps the selection overlay layer in read mode too (base layer, mode-independent)", () => {
    // drawSelection sits in the always-on base layer, outside the mode compartment,
    // so the overlay exists regardless of edit/read — guards against it being
    // accidentally gated behind editable.
    const { view } = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", {
      initialMode: "read",
    });
    expect(view.dom.querySelector(".cm-selectionLayer")).not.toBeNull();
    view.destroy();
  });

  it("keeps the CM selection overlay under vim mode (where native ::selection is dead)", () => {
    const doc = "hello world";
    const { view } = mountEditor(host, doc, "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
      vimMode: "on",
    });
    // Vim is active: its hideNativeSelection (Prec.highest) forces native
    // ::selection transparent, and visual-mode ranges surface as EditorState
    // selection. The whole fix is that the CM drawSelection overlay — not the
    // dead native selection — is the layer that can paint them. Confirm vim is
    // wired AND the overlay layer is still present (outside the vim compartment).
    expect(getCM(view)).not.toBeNull();
    view.dispatch({ selection: { anchor: 0, head: doc.length } });
    expect(view.dom.querySelector(".cm-selectionLayer")).not.toBeNull();
    view.destroy();
  });
});
